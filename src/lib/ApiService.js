'use strict';

class ApiError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
  }
}

const publicClient = (client) => Object.freeze({
  id: client.id,
  name: client.name,
  enabled: client.enabled,
  networkGroup: client.networkGroup,
  address4: client.address4,
  ...(client.address6 ? { address6: client.address6 } : {}),
});

const defaultQrGenerator = (value) => require('qrcode').toString(value, {
  type: 'svg', width: 512, margin: 4, errorCorrectionLevel: 'L',
});

class ApiService {
  constructor({ store, passwordManager, sessionManager, clientManager, qrGenerator = defaultQrGenerator } = {}) {
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
    this.store = store;
    this.passwordManager = passwordManager;
    this.sessionManager = sessionManager;
    this.clientManager = clientManager;
    this.qrGenerator = qrGenerator;
  }

  async login(password, { secureCookie = false } = {}) {
    if (!(await this.passwordManager.verify(password))) throw new ApiError(401, 'Invalid credentials');
    const token = await this.sessionManager.create();
    return Object.freeze({
      authenticated: true,
      cookie: this.sessionManager.cookie(token, { secure: secureCookie }),
    });
  }

  async authorize(token) {
    if (!(await this.sessionManager.verify(token))) throw new ApiError(401, 'Authentication required');
  }

  async session(token) {
    const state = await this.store.load();
    return Object.freeze({
      authenticated: await this.sessionManager.verify(token),
      language: state?.server?.uiLanguage ?? 'en',
    });
  }

  async listClients(token) {
    await this.authorize(token);
    const state = await this.store.load();
    if (!state) throw new ApiError(503, 'AWG-Easy 3 is not initialized');
    return Object.freeze(state.clients.map(publicClient));
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
    return Object.freeze({ client: publicClient(result.client) });
  }

  async updateClient(token, clientId, changes) {
    await this.authorize(token);
    const result = await this.clientManager.updateClient(clientId, changes);
    return publicClient(result.client);
  }

  async deleteClient(token, clientId) {
    await this.authorize(token);
    await this.clientManager.deleteClient(clientId);
    return Object.freeze({ success: true });
  }

  async exportClient(token, clientId, format) {
    await this.authorize(token);
    const artifact = await this.clientManager.getClientExport(clientId);
    if (format === 'vpn-link') {
      return Object.freeze({ contentType: 'text/plain; charset=utf-8', value: artifact.vpnLink });
    }
    if (format === 'native-config') {
      return Object.freeze({ contentType: 'text/plain; charset=utf-8', value: artifact.nativeConfig });
    }
    if (format === 'qr-svg') {
      return Object.freeze({ contentType: 'image/svg+xml; charset=utf-8', value: await this.qrGenerator(artifact.vpnLink) });
    }
    throw new ApiError(400, 'Unknown export format');
  }

  async changePassword(token, currentPassword, newPassword, { secureCookie = false } = {}) {
    await this.authorize(token);
    try {
      await this.passwordManager.changePassword(currentPassword, newPassword);
    } catch (error) {
      if (error.message === 'Current password is incorrect') throw new ApiError(403, error.message);
      throw error;
    }
    return Object.freeze({
      success: true,
      cookie: this.sessionManager.clearCookie({ secure: secureCookie }),
    });
  }

  logout({ secureCookie = false } = {}) {
    return Object.freeze({
      success: true,
      cookie: this.sessionManager.clearCookie({ secure: secureCookie }),
    });
  }
}

module.exports = { ApiError, ApiService, defaultQrGenerator, publicClient };
