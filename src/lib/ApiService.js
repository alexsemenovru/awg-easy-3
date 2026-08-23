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
  routeMode: client.routeMode,
  address4: client.address4,
  ...(client.address6 ? { address6: client.address6 } : {}),
});

class ApiService {
  constructor({ store, passwordManager, sessionManager, clientManager } = {}) {
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
    this.store = store;
    this.passwordManager = passwordManager;
    this.sessionManager = sessionManager;
    this.clientManager = clientManager;
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
    return Object.freeze({ authenticated: await this.sessionManager.verify(token) });
  }

  async listClients(token) {
    await this.authorize(token);
    const state = await this.store.load();
    if (!state) throw new ApiError(503, 'AWG-Easy 3 is not initialized');
    return Object.freeze(state.clients.map(publicClient));
  }

  async createClient(token, input) {
    await this.authorize(token);
    const result = await this.clientManager.createClient(input);
    return Object.freeze({ client: publicClient(result.client), vpnLink: result.export.vpnLink });
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

module.exports = { ApiError, ApiService, publicClient };
