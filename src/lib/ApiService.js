'use strict';

const { clientTraffic } = require('./ClientTraffic');
const { transliterate } = require('transliteration');
const { validateSnapshot } = require('./MainCellStatusSnapshot');
const { assignmentFromClient, assignmentFingerprint } = require('./CellAssignedSettings');

class ApiError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
  }
}

const authError = (error) => {
  if (error instanceof ApiError) return error;
  if (error.message === 'Invalid credentials' || error.message === 'Current password is incorrect') {
    return new ApiError(403, 'Invalid credentials');
  }
  if (error.message === 'TOTP setup expired' || error.message === 'Set up codes first'
    || error.message === 'Use SSH reset to create a new password') return new ApiError(400, error.message);
  if (error.message === 'Disable existing codes before setting up new ones') return new ApiError(409, error.message);
  return error;
};

const publicClient = (client, entryDetails = {}, server = {}) => Object.freeze({
  id: client.id,
  name: client.name,
  ...clientTraffic(client),
  ipv6Available: Boolean(client.address6 && (!client.exitNodeId || (client.exitNodeId === 'main'
    ? server.address6 : entryDetails[client.exitNodeId]?.descriptor?.address6))),
  networkGroup: client.networkGroup,
  ...(client.entryCellId ? { entryCellId: client.entryCellId,
    entryReady: entryDetails[client.entryCellId]?.routeApplied === true
      && entryDetails[client.entryCellId]?.confirmed?.[client.id]
      === assignmentFingerprint(assignmentFromClient(client)) } : {}),
  address4: client.address4,
  ...(client.geoPolicy ? { geoPolicy: client.geoPolicy } : {}),
  ...(client.exitNodeId ? { exitNodeId: client.exitNodeId } : {}),
  ...(client.address6 ? { address6: client.address6 } : {}),
});

const defaultQrGenerator = (value) => require('qrcode').toString(value, {
  type: 'svg', width: 512, margin: 4, errorCorrectionLevel: 'L',
});

const exportFileName = (name) => {
  // Android AWG uses the file stem as a tunnel name (ASCII, at most 15 characters).
  // This affects only the download, never the saved/displayed client name.
  const normalized = transliterate(String(name ?? '').normalize('NFKC').trim())
    .replace(/[^a-zA-Z0-9_=+.-]+/g, '_').replace(/^[_.]+|[_.]+$/g, '').slice(0, 15).replace(/\.+$/g, '');
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(normalized)) return 'AWG-client.conf';
  return `${normalized || 'AWG-client'}.conf`;
};

class ApiService {
  constructor({ store, passwordManager, sessionManager, clientManager, diagnostics,
    geoStatus = () => ({}), cellStatus = async () => ({ state: 'unavailable', updatedAt: null, cells: [] }),
    cellInvitationIssuer = null, backupCreator = null, cellRemover = null,
    cellEntryDetails = async () => ({}),
    qrGenerator = defaultQrGenerator, clock = () => Date.now() } = {}) {
    if (!store || typeof store.load !== 'function') throw new TypeError('store must provide load');
    if (!passwordManager || typeof passwordManager.verify !== 'function'
      || typeof passwordManager.changePassword !== 'function') {
      throw new TypeError('passwordManager is invalid');
    }
    if (!sessionManager || typeof sessionManager.create !== 'function'
      || typeof sessionManager.verify !== 'function') {
      throw new TypeError('sessionManager is invalid');
    }
    if (!clientManager || typeof clientManager.createClient !== 'function') {
      throw new TypeError('clientManager is invalid');
    }
    if (typeof qrGenerator !== 'function') throw new TypeError('qrGenerator must be a function');
    if (diagnostics && typeof diagnostics.snapshot !== 'function') throw new TypeError('diagnostics must provide snapshot');
    if (typeof cellStatus !== 'function') throw new TypeError('Cell status reader required');
    this.store = store;
    this.passwordManager = passwordManager;
    this.sessionManager = sessionManager;
    this.clientManager = clientManager;
    this.qrGenerator = qrGenerator;
    this.diagnostics = diagnostics;
    this.geoStatus = geoStatus;
    this.cellStatus = cellStatus;
    this.cellInvitationIssuer = cellInvitationIssuer;
    this.cellRemover = cellRemover;
    this.cellRemovalQueue = Promise.resolve();
    this.backupCreator = backupCreator;
    this.backupQueue = Promise.resolve();
    this.lastBackupAt = -Infinity;
    this.cellEntryDetails = cellEntryDetails;
    this.cellInvitationQueue = Promise.resolve();
    this.lastCellInvitationAt = -Infinity;
    this.clock = clock;
    this.failedLogins = 0;
    this.loginBlockedUntil = 0;
    this.authQueue = Promise.resolve();
  }

  serializeAuth(action) {
    const result = this.authQueue.then(action);
    this.authQueue = result.catch(() => {});
    return result;
  }

  async limitedAuth(action) {
    return this.serializeAuth(async () => {
      if (this.clock() < this.loginBlockedUntil) throw new ApiError(429, 'Too many attempts. Try again later.');
      try {
        const result = await action();
        this.failedLogins = 0;
        this.loginBlockedUntil = 0;
        return result;
      } catch (error) {
        if (error.statusCode === 401 || error.message === 'Invalid credentials'
          || error.message === 'Current password is incorrect') {
          this.failedLogins += 1;
          if (this.failedLogins >= 5) {
            this.loginBlockedUntil = this.clock() + Math.min(24 * 60 * 60_000,
              30_000 * 2 ** Math.min(12, this.failedLogins - 5));
          }
        }
        throw error;
      }
    });
  }

  async login(password, code, { secureCookie = false } = {}) {
    return this.limitedAuth(async () => {
      const valid = this.passwordManager.authenticate
        ? await this.passwordManager.authenticate(password, code)
        : await this.passwordManager.verify(password);
      if (!valid) throw new ApiError(401, 'Invalid credentials');
      const token = await this.sessionManager.create();
      return Object.freeze({ authenticated: true, cookie: this.sessionManager.cookie(token, { secure: secureCookie }) });
    });
  }

  async authorize(token) {
    if (!(await this.sessionManager.verify(token))) throw new ApiError(401, 'Authentication required');
  }

  async createBackup(token, credentials) {
    await this.authorize(token);
    if (!this.backupCreator) throw new ApiError(503, 'Configuration backup unavailable');
    if (!credentials || Object.keys(credentials).some(key => !['password', 'code'].includes(key))) {
      throw new ApiError(400, 'Invalid backup credentials');
    }
    const task = this.backupQueue.then(async () => {
      await this.authorize(token);
      if (this.clock() - this.lastBackupAt < 60000) throw new ApiError(429, 'Too many attempts. Try again later.');
      await this.limitedAuth(async () => {
        const valid = this.passwordManager.authenticate
          ? await this.passwordManager.authenticate(credentials.password, credentials.code)
          : await this.passwordManager.verify(credentials.password);
        if (!valid) throw new ApiError(403, 'Invalid credentials');
      });
      this.lastBackupAt = this.clock();
      return this.backupCreator();
    });
    this.backupQueue = task.catch(() => {});
    return task;
  }

  async session(token) {
    const state = await this.store.load();
    return Object.freeze({
      authenticated: await this.sessionManager.verify(token),
      language: state?.server?.uiLanguage ?? 'en',
      authMode: state?.auth?.mode ?? 'password',
    });
  }

  async listClients(token) {
    await this.authorize(token);
    const state = await this.store.load();
    if (!state) throw new ApiError(503, 'AWG-Easy 3 is not initialized');
    const details = await this.cellEntryDetails();
    return Object.freeze(state.clients.map(client => publicClient(client, details, state.server)));
  }

  async clientDiagnostics(token) {
    await this.authorize(token);
    if (!this.diagnostics) return Object.freeze([]);
    return this.diagnostics.snapshot();
  }

  async networkInfo(token) {
    await this.authorize(token);
    const state = await this.store.load();
    if (!state) throw new ApiError(503, 'AWG-Easy 3 is not initialized');
    const { address4, address6, ipv6Subnet, panelPort } = state.server;
    return Object.freeze({
      panelIpv4Url: `http://${address4}:${panelPort}/`,
      panelIpv6Url: address6 && ipv6Subnet ? `http://[${address6}]:${panelPort}/` : null,
    });
  }

  async geoInfo(token) {
    await this.authorize(token);
    const status = this.geoStatus();
    return Object.freeze({
      state: ['ready', 'updating', 'stale', 'unavailable'].includes(status.state) ? status.state : 'unavailable',
      source: 'DB-IP Lite', sourceUrl: 'https://db-ip.com',
      release: status.release ?? null, checkedAt: status.checkedAt ?? null,
      countries: Array.isArray(status.countries) ? status.countries.filter(code => /^[A-Z]{2}$/.test(code)).sort() : [],
    });
  }

  async cellsInfo(token) {
    await this.authorize(token);
    const snapshot = await this.cellStatus();
    const entryDetails = await this.cellEntryDetails();
    const clients = (await this.store.load())?.clients ?? [];
    if (!snapshot || !['ready', 'stale', 'unavailable'].includes(snapshot.state)
      || !Array.isArray(snapshot.cells)) throw new Error('Invalid Main Cell status');
    if (snapshot.state === 'ready') validateSnapshot({ version: 1,
      updatedAt: snapshot.updatedAt, cells: snapshot.cells });
    return Object.freeze({ state: snapshot.state,
      updatedAt: snapshot.updatedAt ?? null,
      cells: snapshot.state === 'ready' ? snapshot.cells.map(cell => ({
        id: cell.id, status: cell.status, phase: cell.phase,
        createdAt: cell.createdAt,
        affectedClients: clients.filter(client => client.enabled && (client.entryCellId === cell.id || client.exitNodeId === cell.id)).length,
        entryReady: cell.status === 'consumed' && cell.phase === 'closed'
          && Boolean(entryDetails[cell.id]?.descriptor)
          && entryDetails[cell.id]?.routeApplied === true,
        ...(cell.settings ? { settings: {
          desiredRevision: cell.settings.desiredRevision,
          confirmedRevision: cell.settings.confirmedRevision,
          awaitingAck: cell.settings.awaitingAck,
        } } : {}),
        ...(cell.control ? { control: {
          path: cell.control.path, receivedAt: cell.control.receivedAt,
        } } : {}),
        ...(cell.maintenance ? { maintenance: cell.maintenance } : {}),
        ...(cell.backup ? { backup: {
          generation: cell.backup.generation, confirmed: cell.backup.confirmed,
        } } : {}),
      })) : [] });
  }

  async issueCellInvitation(token) {
    await this.authorize(token);
    if (!this.cellInvitationIssuer) throw new ApiError(503, 'Main Node is not enabled');
    const issue = async () => {
      const now = this.clock();
      if (now - this.lastCellInvitationAt < 10000) {
        throw new ApiError(429, 'Wait before creating another Cell invitation');
      }
      this.lastCellInvitationAt = now;
      try {
        const code = await this.cellInvitationIssuer();
        if (typeof code !== 'string' || code.length < 32 || code.length > 8192) throw new Error();
        return { code };
      } catch { throw new ApiError(503, 'Cell invitation unavailable'); }
    };
    const result = this.cellInvitationQueue.then(issue);
    this.cellInvitationQueue = result.catch(() => {});
    return result;
  }

  async removeCell(token, id, context) {
    await this.authorize(token);
    if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id)) throw new ApiError(400, 'Invalid Cell identifier');
    if (!this.cellRemover) throw new ApiError(503, 'Main Node is not enabled');
    const remove = async () => {
      const inventory = await this.cellsInfo(token);
      if (inventory.state !== 'ready' || !inventory.cells.some(cell => cell.id === id && cell.status === 'consumed' && cell.phase === 'closed')) {
        throw new ApiError(409, 'Cell registry unavailable');
      }
      await this.clientManager.disableCellClients(id, context);
      return this.cellRemover(id);
    };
    const result = this.cellRemovalQueue.then(remove, remove);
    this.cellRemovalQueue = result.catch(() => {});
    return result;
  }

  async createClient(token, input) {
    await this.authorize(token);
    let result;
    try {
      result = await this.clientManager.createClient(input);
    } catch (error) {
      if (error.code === 'CLIENT_NAME_EXISTS') throw new ApiError(409, error.message);
      throw error;
    }
    return Object.freeze({ client: publicClient(result.client, await this.cellEntryDetails(), (await this.store.load()).server) });
  }

  async updateClient(token, clientId, changes, context) {
    await this.authorize(token);
    const result = await this.clientManager.updateClient(clientId, changes, context);
    return publicClient(result.client, await this.cellEntryDetails(), (await this.store.load()).server);
  }

  async deleteClient(token, clientId, context) {
    await this.authorize(token);
    await this.clientManager.deleteClient(clientId, context);
    return Object.freeze({ success: true });
  }

  async exportClient(token, clientId, format) {
    await this.authorize(token);
    let artifact;
    try { artifact = await this.clientManager.getClientExport(clientId); }
    catch (error) {
      if (error.code === 'CELL_PENDING') throw new ApiError(409, error.message);
      throw error;
    }
    if (format === 'vpn-link') {
      return Object.freeze({ contentType: 'text/plain; charset=utf-8', value: artifact.vpnLink });
    }
    if (format === 'native-config') {
      const state = await this.store.load();
      const client = state?.clients.find((item) => item.id === clientId);
      return Object.freeze({
        contentType: 'application/octet-stream',
        downloadName: exportFileName(client?.name),
        value: artifact.nativeConfig,
      });
    }
    if (format === 'qr-svg') {
      return Object.freeze({ contentType: 'image/svg+xml; charset=utf-8', value: await this.qrGenerator(artifact.vpnLink) });
    }
    throw new ApiError(400, 'Unknown export format');
  }

  async changePassword(token, currentPassword, newPassword, code, { secureCookie = false } = {}) {
    await this.authorize(token);
    try {
      await this.limitedAuth(() => this.passwordManager.changePassword(currentPassword, newPassword, code));
    } catch (error) {
      throw authError(error);
    }
    return Object.freeze({
      success: true,
      cookie: this.sessionManager.clearCookie({ secure: secureCookie }),
    });
  }

  async beginTotp(token, proof) {
    await this.authorize(token);
    let setup;
    try { setup = await this.limitedAuth(() => this.passwordManager.beginTotp(proof)); }
    catch (error) { throw authError(error); }
    return Object.freeze({ secret: setup.secret, qrSvg: await this.qrGenerator(setup.uri) });
  }

  async confirmTotp(token, password, code) {
    await this.authorize(token);
    try { await this.limitedAuth(() => this.passwordManager.confirmTotp(password, code)); }
    catch (error) { throw authError(error); }
    return Object.freeze({ success: true, cookie: this.sessionManager.clearCookie() });
  }

  async setAuthMode(token, mode, proof, newPassword) {
    await this.authorize(token);
    try { await this.limitedAuth(() => this.passwordManager.setMode(mode, proof, newPassword)); }
    catch (error) { throw authError(error); }
    return Object.freeze({ success: true, cookie: this.sessionManager.clearCookie() });
  }

  logout({ secureCookie = false } = {}) {
    return Object.freeze({
      success: true,
      cookie: this.sessionManager.clearCookie({ secure: secureCookie }),
    });
  }
}

module.exports = { ApiError, ApiService, defaultQrGenerator, exportFileName, publicClient };
