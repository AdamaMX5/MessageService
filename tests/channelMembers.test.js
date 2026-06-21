// Tests for channel membership-management endpoints:
//   GET    /channels/:channelId/members
//   POST   /channels/:channelId/members
//   DELETE /channels/:channelId/members/:userId
//   POST   /channels/:channelId/admins
//   DELETE /channels/:channelId/admins/:userId
//
// Authorization model under test (see src/middleware/loadChannel.js, src/routes/channels.js):
//   - channelAdmin = JWT sub in channel adminIds, OR sub === createdBy (creator is implicit admin)
//   - serviceAdmin = JWT role `admin`
//   - canManage    = channelAdmin OR serviceAdmin (service-admins need not be members)
//   - self-leave   = any member may remove themselves from /members/:userId
//
// No real MongoDB or network is available in this environment, so we mock:
//   - src/services/jwtService     -> verifyToken returns a controllable payload { sub, roles }
//   - src/services/channelService -> getChannelInfo() drives loadChannel's perms; the mutators
//     (addMember/removeMember/addAdmin/removeAdmin) are mocked individually per call.
//
// The real Express app (src/app.js) is exercised end-to-end via supertest, so routing and
// middleware ordering (auth -> loadChannel) are verified against the real wiring.

jest.mock('../src/services/jwtService', () => ({
  verifyToken: jest.fn(),
  getPublicKey: jest.fn().mockResolvedValue('fake-public-key'),
  refreshPublicKey: jest.fn().mockResolvedValue('fake-public-key'),
}));

jest.mock('../src/services/channelService', () => {
  class ChannelNotFoundError extends Error {
    constructor(channelId) {
      super(`Channel not found: ${channelId}`);
      this.name = 'ChannelNotFoundError';
    }
  }
  return {
    getChannelInfo: jest.fn(),
    isMember: jest.fn(),
    getMemberIds: jest.fn(),
    addMember: jest.fn(),
    removeMember: jest.fn(),
    addAdmin: jest.fn(),
    removeAdmin: jest.fn(),
    clearCache: jest.fn(),
    ChannelNotFoundError,
  };
});

const request = require('supertest');
const { verifyToken } = require('../src/services/jwtService');
const {
  getChannelInfo,
  addMember,
  removeMember,
  addAdmin,
  removeAdmin,
  ChannelNotFoundError,
} = require('../src/services/channelService');
const app = require('../src/app');

const USER_ID = 'user-123'; // plain member
const CHANNEL_ADMIN_VIA_LIST_ID = 'user-admin-1'; // present in adminIds
const CREATOR_ID = 'user-creator'; // === createdBy, implicit admin
const SERVICE_ADMIN_ID = 'user-svc-admin'; // JWT role 'admin', not necessarily a member
const OUTSIDER_ID = 'user-outsider'; // not a member, not an admin, no roles
const TARGET_USER_ID = 'user-target'; // id being added/removed in mutation tests
const CHANNEL_ID = 'channel-abc';
const TOKEN = 'fake.jwt.token';

function authHeader(token = TOKEN) {
  return { Authorization: `Bearer ${token}` };
}

function asUser(sub, roles = []) {
  verifyToken.mockImplementation(() => ({ sub, email: `${sub}@example.com`, roles }));
}

function baseChannelInfo(overrides = {}) {
  return {
    memberIds: [USER_ID, CHANNEL_ADMIN_VIA_LIST_ID, CREATOR_ID],
    adminIds: [CHANNEL_ADMIN_VIA_LIST_ID],
    createdBy: CREATOR_ID,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  asUser(USER_ID);
  getChannelInfo.mockResolvedValue(baseChannelInfo());
});

// ── GET /channels/:channelId/members ───────────────────────────────────────

describe('GET /channels/:channelId/members', () => {
  test('200 for a plain member', async () => {
    asUser(USER_ID);

    const res = await request(app)
      .get(`/channels/${CHANNEL_ID}/members`)
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      memberIds: [USER_ID, CHANNEL_ADMIN_VIA_LIST_ID, CREATOR_ID],
      adminIds: [CHANNEL_ADMIN_VIA_LIST_ID],
    });
  });

  test('200 for a channel admin (via adminIds) who is also a member', async () => {
    asUser(CHANNEL_ADMIN_VIA_LIST_ID);

    const res = await request(app)
      .get(`/channels/${CHANNEL_ID}/members`)
      .set(authHeader());

    expect(res.status).toBe(200);
  });

  test('200 for the creator (implicit admin via createdBy)', async () => {
    asUser(CREATOR_ID);

    const res = await request(app)
      .get(`/channels/${CHANNEL_ID}/members`)
      .set(authHeader());

    expect(res.status).toBe(200);
  });

  test('200 for a service-admin who is NOT a member', async () => {
    asUser(SERVICE_ADMIN_ID, ['admin']);

    const res = await request(app)
      .get(`/channels/${CHANNEL_ID}/members`)
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      memberIds: [USER_ID, CHANNEL_ADMIN_VIA_LIST_ID, CREATOR_ID],
      adminIds: [CHANNEL_ADMIN_VIA_LIST_ID],
    });
  });

  test('403 for an outsider (not member, not admin, no service role)', async () => {
    asUser(OUTSIDER_ID);

    const res = await request(app)
      .get(`/channels/${CHANNEL_ID}/members`)
      .set(authHeader());

    expect(res.status).toBe(403);
  });

  test('400 for a malformed channelId — no channel lookup performed', async () => {
    const res = await request(app)
      .get('/channels/bad%24id/members')
      .set(authHeader());

    expect(res.status).toBe(400);
    expect(getChannelInfo).not.toHaveBeenCalled();
  });

  test('404 for an unknown channel', async () => {
    getChannelInfo.mockRejectedValue(new ChannelNotFoundError(CHANNEL_ID));

    const res = await request(app)
      .get(`/channels/${CHANNEL_ID}/members`)
      .set(authHeader());

    expect(res.status).toBe(404);
  });

  test('401 when no token is provided', async () => {
    const res = await request(app).get(`/channels/${CHANNEL_ID}/members`);

    expect(res.status).toBe(401);
    expect(getChannelInfo).not.toHaveBeenCalled();
  });
});

// ── POST /channels/:channelId/members ──────────────────────────────────────

describe('POST /channels/:channelId/members', () => {
  function mutatedResult() {
    return {
      memberIds: [USER_ID, CHANNEL_ADMIN_VIA_LIST_ID, CREATOR_ID, TARGET_USER_ID],
      adminIds: [CHANNEL_ADMIN_VIA_LIST_ID],
    };
  }

  test('200: channel admin (via adminIds) can add a member', async () => {
    asUser(CHANNEL_ADMIN_VIA_LIST_ID);
    addMember.mockResolvedValue(mutatedResult());

    const res = await request(app)
      .post(`/channels/${CHANNEL_ID}/members`)
      .set(authHeader())
      .send({ userId: TARGET_USER_ID });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(mutatedResult());
    expect(addMember).toHaveBeenCalledWith(CHANNEL_ID, TARGET_USER_ID);
  });

  test('200: creator (implicit admin) can add a member', async () => {
    asUser(CREATOR_ID);
    addMember.mockResolvedValue(mutatedResult());

    const res = await request(app)
      .post(`/channels/${CHANNEL_ID}/members`)
      .set(authHeader())
      .send({ userId: TARGET_USER_ID });

    expect(res.status).toBe(200);
    expect(addMember).toHaveBeenCalledWith(CHANNEL_ID, TARGET_USER_ID);
  });

  test('200: service-admin (not a member) can add a member', async () => {
    asUser(SERVICE_ADMIN_ID, ['admin']);
    addMember.mockResolvedValue(mutatedResult());

    const res = await request(app)
      .post(`/channels/${CHANNEL_ID}/members`)
      .set(authHeader())
      .send({ userId: TARGET_USER_ID });

    expect(res.status).toBe(200);
    expect(addMember).toHaveBeenCalledWith(CHANNEL_ID, TARGET_USER_ID);
  });

  test('403: plain member cannot add a member', async () => {
    asUser(USER_ID);

    const res = await request(app)
      .post(`/channels/${CHANNEL_ID}/members`)
      .set(authHeader())
      .send({ userId: TARGET_USER_ID });

    expect(res.status).toBe(403);
    expect(addMember).not.toHaveBeenCalled();
  });

  test('403: outsider (non-member, non-admin) cannot add a member', async () => {
    asUser(OUTSIDER_ID);

    const res = await request(app)
      .post(`/channels/${CHANNEL_ID}/members`)
      .set(authHeader())
      .send({ userId: TARGET_USER_ID });

    expect(res.status).toBe(403);
    expect(addMember).not.toHaveBeenCalled();
  });

  test('400: userId missing', async () => {
    asUser(CHANNEL_ADMIN_VIA_LIST_ID);

    const res = await request(app)
      .post(`/channels/${CHANNEL_ID}/members`)
      .set(authHeader())
      .send({});

    expect(res.status).toBe(400);
    expect(addMember).not.toHaveBeenCalled();
  });

  test('400: userId empty string', async () => {
    asUser(CHANNEL_ADMIN_VIA_LIST_ID);

    const res = await request(app)
      .post(`/channels/${CHANNEL_ID}/members`)
      .set(authHeader())
      .send({ userId: '' });

    expect(res.status).toBe(400);
    expect(addMember).not.toHaveBeenCalled();
  });

  test('400: userId contains "@" (looks like an email)', async () => {
    asUser(CHANNEL_ADMIN_VIA_LIST_ID);

    const res = await request(app)
      .post(`/channels/${CHANNEL_ID}/members`)
      .set(authHeader())
      .send({ userId: 'someone@example.com' });

    expect(res.status).toBe(400);
    expect(addMember).not.toHaveBeenCalled();
  });

  test('400: userId longer than 128 chars', async () => {
    asUser(CHANNEL_ADMIN_VIA_LIST_ID);

    const res = await request(app)
      .post(`/channels/${CHANNEL_ID}/members`)
      .set(authHeader())
      .send({ userId: 'a'.repeat(129) });

    expect(res.status).toBe(400);
    expect(addMember).not.toHaveBeenCalled();
  });

  test('400: malformed channelId — no channel lookup performed', async () => {
    const res = await request(app)
      .post('/channels/bad%24id/members')
      .set(authHeader())
      .send({ userId: TARGET_USER_ID });

    expect(res.status).toBe(400);
    expect(getChannelInfo).not.toHaveBeenCalled();
    expect(addMember).not.toHaveBeenCalled();
  });

  test('404: unknown channel', async () => {
    asUser(CHANNEL_ADMIN_VIA_LIST_ID);
    getChannelInfo.mockRejectedValue(new ChannelNotFoundError(CHANNEL_ID));

    const res = await request(app)
      .post(`/channels/${CHANNEL_ID}/members`)
      .set(authHeader())
      .send({ userId: TARGET_USER_ID });

    expect(res.status).toBe(404);
    expect(addMember).not.toHaveBeenCalled();
  });

  test('401: no token provided', async () => {
    const res = await request(app)
      .post(`/channels/${CHANNEL_ID}/members`)
      .send({ userId: TARGET_USER_ID });

    expect(res.status).toBe(401);
    expect(getChannelInfo).not.toHaveBeenCalled();
    expect(addMember).not.toHaveBeenCalled();
  });
});

// ── DELETE /channels/:channelId/members/:userId ────────────────────────────

describe('DELETE /channels/:channelId/members/:userId', () => {
  function mutatedResult() {
    return {
      memberIds: [CHANNEL_ADMIN_VIA_LIST_ID, CREATOR_ID],
      adminIds: [CHANNEL_ADMIN_VIA_LIST_ID],
    };
  }

  test('200: channel admin (via adminIds) can remove another member', async () => {
    asUser(CHANNEL_ADMIN_VIA_LIST_ID);
    removeMember.mockResolvedValue(mutatedResult());

    const res = await request(app)
      .delete(`/channels/${CHANNEL_ID}/members/${USER_ID}`)
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body).toEqual(mutatedResult());
    expect(removeMember).toHaveBeenCalledWith(CHANNEL_ID, USER_ID);
  });

  test('200: creator (implicit admin) can remove another member', async () => {
    asUser(CREATOR_ID);
    removeMember.mockResolvedValue(mutatedResult());

    const res = await request(app)
      .delete(`/channels/${CHANNEL_ID}/members/${USER_ID}`)
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(removeMember).toHaveBeenCalledWith(CHANNEL_ID, USER_ID);
  });

  test('200: service-admin (not a member) can remove a member', async () => {
    asUser(SERVICE_ADMIN_ID, ['admin']);
    removeMember.mockResolvedValue(mutatedResult());

    const res = await request(app)
      .delete(`/channels/${CHANNEL_ID}/members/${USER_ID}`)
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(removeMember).toHaveBeenCalledWith(CHANNEL_ID, USER_ID);
  });

  test('200: self-leave — a member may remove themselves', async () => {
    asUser(USER_ID); // plain member, not channelAdmin/serviceAdmin
    removeMember.mockResolvedValue(mutatedResult());

    const res = await request(app)
      .delete(`/channels/${CHANNEL_ID}/members/${USER_ID}`)
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(removeMember).toHaveBeenCalledWith(CHANNEL_ID, USER_ID);
  });

  // Creator protection (HOCH fix): createdBy can never be removed, even by an
  // admin/service-admin, and even when the creator attempts to self-leave.
  test('409: channel admin cannot remove the creator', async () => {
    asUser(CHANNEL_ADMIN_VIA_LIST_ID);

    const res = await request(app)
      .delete(`/channels/${CHANNEL_ID}/members/${CREATOR_ID}`)
      .set(authHeader());

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'The channel creator cannot be removed' });
    expect(removeMember).not.toHaveBeenCalled();
  });

  test('409: service-admin cannot remove the creator', async () => {
    asUser(SERVICE_ADMIN_ID, ['admin']);

    const res = await request(app)
      .delete(`/channels/${CHANNEL_ID}/members/${CREATOR_ID}`)
      .set(authHeader());

    expect(res.status).toBe(409);
    expect(removeMember).not.toHaveBeenCalled();
  });

  test('409: creator cannot self-leave', async () => {
    asUser(CREATOR_ID); // creator is a member and an implicit admin

    const res = await request(app)
      .delete(`/channels/${CHANNEL_ID}/members/${CREATOR_ID}`)
      .set(authHeader());

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'The channel creator cannot be removed' });
    expect(removeMember).not.toHaveBeenCalled();
  });

  test('403: plain member cannot remove a DIFFERENT member (not self-leave, not canManage)', async () => {
    asUser(USER_ID);

    const res = await request(app)
      .delete(`/channels/${CHANNEL_ID}/members/${CHANNEL_ADMIN_VIA_LIST_ID}`)
      .set(authHeader());

    expect(res.status).toBe(403);
    expect(removeMember).not.toHaveBeenCalled();
  });

  test('403: outsider (non-member, non-admin) cannot remove anyone, including themselves', async () => {
    asUser(OUTSIDER_ID);

    const res = await request(app)
      .delete(`/channels/${CHANNEL_ID}/members/${OUTSIDER_ID}`)
      .set(authHeader());

    expect(res.status).toBe(403);
    expect(removeMember).not.toHaveBeenCalled();
  });

  test('400: invalid userId in path (contains "@")', async () => {
    asUser(CHANNEL_ADMIN_VIA_LIST_ID);

    const res = await request(app)
      .delete(`/channels/${CHANNEL_ID}/members/${encodeURIComponent('someone@example.com')}`)
      .set(authHeader());

    expect(res.status).toBe(400);
    expect(removeMember).not.toHaveBeenCalled();
  });

  test('400: malformed channelId — no channel lookup performed', async () => {
    const res = await request(app)
      .delete(`/channels/bad%24id/members/${USER_ID}`)
      .set(authHeader());

    expect(res.status).toBe(400);
    expect(getChannelInfo).not.toHaveBeenCalled();
    expect(removeMember).not.toHaveBeenCalled();
  });

  test('404: unknown channel', async () => {
    asUser(CHANNEL_ADMIN_VIA_LIST_ID);
    getChannelInfo.mockRejectedValue(new ChannelNotFoundError(CHANNEL_ID));

    const res = await request(app)
      .delete(`/channels/${CHANNEL_ID}/members/${USER_ID}`)
      .set(authHeader());

    expect(res.status).toBe(404);
    expect(removeMember).not.toHaveBeenCalled();
  });

  test('401: no token provided', async () => {
    const res = await request(app).delete(`/channels/${CHANNEL_ID}/members/${USER_ID}`);

    expect(res.status).toBe(401);
    expect(getChannelInfo).not.toHaveBeenCalled();
    expect(removeMember).not.toHaveBeenCalled();
  });
});

// ── POST /channels/:channelId/admins ───────────────────────────────────────

describe('POST /channels/:channelId/admins', () => {
  function mutatedResult() {
    return {
      memberIds: [USER_ID, CHANNEL_ADMIN_VIA_LIST_ID, CREATOR_ID],
      adminIds: [CHANNEL_ADMIN_VIA_LIST_ID, TARGET_USER_ID],
    };
  }

  test('200: channel admin (via adminIds) can promote a user to admin', async () => {
    asUser(CHANNEL_ADMIN_VIA_LIST_ID);
    addAdmin.mockResolvedValue(mutatedResult());

    const res = await request(app)
      .post(`/channels/${CHANNEL_ID}/admins`)
      .set(authHeader())
      .send({ userId: TARGET_USER_ID });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(mutatedResult());
    expect(addAdmin).toHaveBeenCalledWith(CHANNEL_ID, TARGET_USER_ID);
  });

  test('200: creator (implicit admin) can promote a user to admin', async () => {
    asUser(CREATOR_ID);
    addAdmin.mockResolvedValue(mutatedResult());

    const res = await request(app)
      .post(`/channels/${CHANNEL_ID}/admins`)
      .set(authHeader())
      .send({ userId: TARGET_USER_ID });

    expect(res.status).toBe(200);
    expect(addAdmin).toHaveBeenCalledWith(CHANNEL_ID, TARGET_USER_ID);
  });

  test('200: service-admin (not a member) can promote a user to admin', async () => {
    asUser(SERVICE_ADMIN_ID, ['admin']);
    addAdmin.mockResolvedValue(mutatedResult());

    const res = await request(app)
      .post(`/channels/${CHANNEL_ID}/admins`)
      .set(authHeader())
      .send({ userId: TARGET_USER_ID });

    expect(res.status).toBe(200);
    expect(addAdmin).toHaveBeenCalledWith(CHANNEL_ID, TARGET_USER_ID);
  });

  test('403: plain member cannot promote a user to admin', async () => {
    asUser(USER_ID);

    const res = await request(app)
      .post(`/channels/${CHANNEL_ID}/admins`)
      .set(authHeader())
      .send({ userId: TARGET_USER_ID });

    expect(res.status).toBe(403);
    expect(addAdmin).not.toHaveBeenCalled();
  });

  test('403: outsider cannot promote a user to admin', async () => {
    asUser(OUTSIDER_ID);

    const res = await request(app)
      .post(`/channels/${CHANNEL_ID}/admins`)
      .set(authHeader())
      .send({ userId: TARGET_USER_ID });

    expect(res.status).toBe(403);
    expect(addAdmin).not.toHaveBeenCalled();
  });

  test('400: userId missing', async () => {
    asUser(CHANNEL_ADMIN_VIA_LIST_ID);

    const res = await request(app)
      .post(`/channels/${CHANNEL_ID}/admins`)
      .set(authHeader())
      .send({});

    expect(res.status).toBe(400);
    expect(addAdmin).not.toHaveBeenCalled();
  });

  test('400: userId contains "@" (looks like an email)', async () => {
    asUser(CHANNEL_ADMIN_VIA_LIST_ID);

    const res = await request(app)
      .post(`/channels/${CHANNEL_ID}/admins`)
      .set(authHeader())
      .send({ userId: 'someone@example.com' });

    expect(res.status).toBe(400);
    expect(addAdmin).not.toHaveBeenCalled();
  });

  test('400: userId longer than 128 chars', async () => {
    asUser(CHANNEL_ADMIN_VIA_LIST_ID);

    const res = await request(app)
      .post(`/channels/${CHANNEL_ID}/admins`)
      .set(authHeader())
      .send({ userId: 'a'.repeat(129) });

    expect(res.status).toBe(400);
    expect(addAdmin).not.toHaveBeenCalled();
  });

  test('400: malformed channelId — no channel lookup performed', async () => {
    const res = await request(app)
      .post('/channels/bad%24id/admins')
      .set(authHeader())
      .send({ userId: TARGET_USER_ID });

    expect(res.status).toBe(400);
    expect(getChannelInfo).not.toHaveBeenCalled();
    expect(addAdmin).not.toHaveBeenCalled();
  });

  test('404: unknown channel', async () => {
    asUser(CHANNEL_ADMIN_VIA_LIST_ID);
    getChannelInfo.mockRejectedValue(new ChannelNotFoundError(CHANNEL_ID));

    const res = await request(app)
      .post(`/channels/${CHANNEL_ID}/admins`)
      .set(authHeader())
      .send({ userId: TARGET_USER_ID });

    expect(res.status).toBe(404);
    expect(addAdmin).not.toHaveBeenCalled();
  });

  test('401: no token provided', async () => {
    const res = await request(app)
      .post(`/channels/${CHANNEL_ID}/admins`)
      .send({ userId: TARGET_USER_ID });

    expect(res.status).toBe(401);
    expect(getChannelInfo).not.toHaveBeenCalled();
    expect(addAdmin).not.toHaveBeenCalled();
  });
});

// ── DELETE /channels/:channelId/admins/:userId ─────────────────────────────

describe('DELETE /channels/:channelId/admins/:userId', () => {
  function mutatedResult() {
    return {
      memberIds: [USER_ID, CHANNEL_ADMIN_VIA_LIST_ID, CREATOR_ID],
      adminIds: [],
    };
  }

  test('200: channel admin (via adminIds) can demote another channel admin', async () => {
    asUser(CHANNEL_ADMIN_VIA_LIST_ID);
    removeAdmin.mockResolvedValue(mutatedResult());

    const res = await request(app)
      .delete(`/channels/${CHANNEL_ID}/admins/${CHANNEL_ADMIN_VIA_LIST_ID}`)
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body).toEqual(mutatedResult());
    expect(removeAdmin).toHaveBeenCalledWith(CHANNEL_ID, CHANNEL_ADMIN_VIA_LIST_ID);
  });

  test('200: creator (implicit admin) can demote a channel admin', async () => {
    asUser(CREATOR_ID);
    removeAdmin.mockResolvedValue(mutatedResult());

    const res = await request(app)
      .delete(`/channels/${CHANNEL_ID}/admins/${CHANNEL_ADMIN_VIA_LIST_ID}`)
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(removeAdmin).toHaveBeenCalledWith(CHANNEL_ID, CHANNEL_ADMIN_VIA_LIST_ID);
  });

  test('200: service-admin (not a member) can demote a channel admin', async () => {
    asUser(SERVICE_ADMIN_ID, ['admin']);
    removeAdmin.mockResolvedValue(mutatedResult());

    const res = await request(app)
      .delete(`/channels/${CHANNEL_ID}/admins/${CHANNEL_ADMIN_VIA_LIST_ID}`)
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(removeAdmin).toHaveBeenCalledWith(CHANNEL_ID, CHANNEL_ADMIN_VIA_LIST_ID);
  });

  test('403: plain member cannot demote a channel admin', async () => {
    asUser(USER_ID);

    const res = await request(app)
      .delete(`/channels/${CHANNEL_ID}/admins/${CHANNEL_ADMIN_VIA_LIST_ID}`)
      .set(authHeader());

    expect(res.status).toBe(403);
    expect(removeAdmin).not.toHaveBeenCalled();
  });

  test('403: outsider cannot demote a channel admin', async () => {
    asUser(OUTSIDER_ID);

    const res = await request(app)
      .delete(`/channels/${CHANNEL_ID}/admins/${CHANNEL_ADMIN_VIA_LIST_ID}`)
      .set(authHeader());

    expect(res.status).toBe(403);
    expect(removeAdmin).not.toHaveBeenCalled();
  });

  // Creator protection (HOCH fix): createdBy is a permanent admin and can never
  // be demoted, even by another admin or a service-admin.
  test('409: channel admin cannot demote the creator', async () => {
    asUser(CHANNEL_ADMIN_VIA_LIST_ID);

    const res = await request(app)
      .delete(`/channels/${CHANNEL_ID}/admins/${CREATOR_ID}`)
      .set(authHeader());

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'The channel creator cannot be demoted' });
    expect(removeAdmin).not.toHaveBeenCalled();
  });

  test('409: service-admin cannot demote the creator', async () => {
    asUser(SERVICE_ADMIN_ID, ['admin']);

    const res = await request(app)
      .delete(`/channels/${CHANNEL_ID}/admins/${CREATOR_ID}`)
      .set(authHeader());

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'The channel creator cannot be demoted' });
    expect(removeAdmin).not.toHaveBeenCalled();
  });

  test('400: invalid userId in path (contains "@")', async () => {
    asUser(CHANNEL_ADMIN_VIA_LIST_ID);

    const res = await request(app)
      .delete(`/channels/${CHANNEL_ID}/admins/${encodeURIComponent('someone@example.com')}`)
      .set(authHeader());

    expect(res.status).toBe(400);
    expect(removeAdmin).not.toHaveBeenCalled();
  });

  test('400: malformed channelId — no channel lookup performed', async () => {
    const res = await request(app)
      .delete(`/channels/bad%24id/admins/${CHANNEL_ADMIN_VIA_LIST_ID}`)
      .set(authHeader());

    expect(res.status).toBe(400);
    expect(getChannelInfo).not.toHaveBeenCalled();
    expect(removeAdmin).not.toHaveBeenCalled();
  });

  test('404: unknown channel', async () => {
    asUser(CHANNEL_ADMIN_VIA_LIST_ID);
    getChannelInfo.mockRejectedValue(new ChannelNotFoundError(CHANNEL_ID));

    const res = await request(app)
      .delete(`/channels/${CHANNEL_ID}/admins/${CHANNEL_ADMIN_VIA_LIST_ID}`)
      .set(authHeader());

    expect(res.status).toBe(404);
    expect(removeAdmin).not.toHaveBeenCalled();
  });

  test('401: no token provided', async () => {
    const res = await request(app).delete(`/channels/${CHANNEL_ID}/admins/${CHANNEL_ADMIN_VIA_LIST_ID}`);

    expect(res.status).toBe(401);
    expect(getChannelInfo).not.toHaveBeenCalled();
    expect(removeAdmin).not.toHaveBeenCalled();
  });
});
