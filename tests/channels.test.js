// Tests for issue #1 — channel-scoped messages with member-based access control.
//
// No real MongoDB or network is available in this environment, so we mock:
//   - src/services/jwtService  -> verifyToken returns a fake payload (controls req.user.sub)
//   - src/services/channelService -> controls isMember()/ChannelNotFoundError per test
//   - src/models/ChannelMessage -> mocks create() and the find().sort().skip().limit() chain
//
// The real Express app (src/app.js) is exercised end-to-end via supertest, so routing,
// middleware ordering (auth -> requireChannelMembership) and status codes are verified
// against the real wiring, not a reimplementation of it.

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
    isMember: jest.fn(),
    getMemberIds: jest.fn(),
    clearCache: jest.fn(),
    ChannelNotFoundError,
  };
});

jest.mock('../src/models/ChannelMessage');

const request = require('supertest');
const { verifyToken } = require('../src/services/jwtService');
const { isMember, ChannelNotFoundError } = require('../src/services/channelService');
const ChannelMessage = require('../src/models/ChannelMessage');
const app = require('../src/app');

const USER_ID = 'user-123';
const OTHER_USER_ID = 'user-999';
const CHANNEL_ID = 'channel-abc';
const TOKEN = 'fake.jwt.token';

function authHeader(token = TOKEN) {
  return { Authorization: `Bearer ${token}` };
}

beforeEach(() => {
  jest.clearAllMocks();
  // Default: token is always "valid" and decodes to USER_ID unless a test overrides it.
  verifyToken.mockImplementation(() => ({ sub: USER_ID, email: 'u@example.com', roles: [] }));
});

describe('POST /channels/:channelId/messages', () => {
  test('201 happy path returns ServiceMessage shape with no recipientId/readAt', async () => {
    isMember.mockResolvedValue(true);

    const createdAt = new Date('2024-01-01T00:00:00.000Z');
    const fakeDoc = {
      id: 'msg-1',
      senderId: USER_ID,
      channelId: CHANNEL_ID,
      body: 'hello channel',
      createdAt,
    };
    ChannelMessage.create.mockResolvedValue(fakeDoc);

    const res = await request(app)
      .post(`/channels/${CHANNEL_ID}/messages`)
      .set(authHeader())
      .send({ body: 'hello channel' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: 'msg-1',
      senderId: USER_ID,
      channelId: CHANNEL_ID,
      body: 'hello channel',
    });
    expect(res.body).toHaveProperty('createdAt');
    expect(res.body).not.toHaveProperty('recipientId');
    expect(res.body).not.toHaveProperty('readAt');

    expect(ChannelMessage.create).toHaveBeenCalledWith({
      senderId: USER_ID,
      channelId: CHANNEL_ID,
      body: 'hello channel',
    });
    expect(isMember).toHaveBeenCalledWith(CHANNEL_ID, USER_ID);
  });

  test('400 when body is missing', async () => {
    isMember.mockResolvedValue(true);

    const res = await request(app)
      .post(`/channels/${CHANNEL_ID}/messages`)
      .set(authHeader())
      .send({});

    expect(res.status).toBe(400);
    expect(ChannelMessage.create).not.toHaveBeenCalled();
  });

  test('400 when body is an empty/whitespace string', async () => {
    isMember.mockResolvedValue(true);

    const res = await request(app)
      .post(`/channels/${CHANNEL_ID}/messages`)
      .set(authHeader())
      .send({ body: '   ' });

    expect(res.status).toBe(400);
    expect(ChannelMessage.create).not.toHaveBeenCalled();
  });

  test('403 when caller is not a channel member — no message content created', async () => {
    isMember.mockResolvedValue(false);

    const res = await request(app)
      .post(`/channels/${CHANNEL_ID}/messages`)
      .set(authHeader())
      .send({ body: 'sneaky' });

    expect(res.status).toBe(403);
    expect(ChannelMessage.create).not.toHaveBeenCalled();
    // Non-members must receive no channel metadata in the response body.
    expect(res.body).not.toHaveProperty('channelId');
    expect(res.body).not.toHaveProperty('memberIds');
  });

  test('404 when channel is unknown', async () => {
    isMember.mockRejectedValue(new ChannelNotFoundError(CHANNEL_ID));

    const res = await request(app)
      .post(`/channels/${CHANNEL_ID}/messages`)
      .set(authHeader())
      .send({ body: 'hello' });

    expect(res.status).toBe(404);
    expect(ChannelMessage.create).not.toHaveBeenCalled();
  });

  test('400 when channelId is malformed — no membership lookup performed', async () => {
    const res = await request(app)
      .post('/channels/bad%24id/messages') // "bad$id" — fails the channelId pattern
      .set(authHeader())
      .send({ body: 'hello' });

    expect(res.status).toBe(400);
    expect(isMember).not.toHaveBeenCalled();
    expect(ChannelMessage.create).not.toHaveBeenCalled();
  });

  test('401 when no token is provided', async () => {
    const res = await request(app)
      .post(`/channels/${CHANNEL_ID}/messages`)
      .send({ body: 'hello' });

    expect(res.status).toBe(401);
    expect(isMember).not.toHaveBeenCalled();
    expect(ChannelMessage.create).not.toHaveBeenCalled();
  });

  test('401 when token verification fails', async () => {
    verifyToken.mockImplementation(() => {
      throw new Error('invalid signature');
    });

    const res = await request(app)
      .post(`/channels/${CHANNEL_ID}/messages`)
      .set(authHeader('garbage'))
      .send({ body: 'hello' });

    expect(res.status).toBe(401);
    expect(isMember).not.toHaveBeenCalled();
  });
});

describe('GET /channels/:channelId/messages', () => {
  // Helper to build the mongoose-style chainable query mock used by the route:
  // ChannelMessage.find(filter).sort().skip().limit()
  function mockFindChain(resolvedMessages) {
    const chain = {
      sort: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue(resolvedMessages),
    };
    ChannelMessage.find.mockReturnValue(chain);
    return chain;
  }

  test('200 returns { data: [...] } for a member, with default pagination', async () => {
    isMember.mockResolvedValue(true);
    const messages = [
      { id: 'm2', senderId: OTHER_USER_ID, channelId: CHANNEL_ID, body: 'second', createdAt: new Date() },
      { id: 'm1', senderId: USER_ID, channelId: CHANNEL_ID, body: 'first', createdAt: new Date() },
    ];
    const chain = mockFindChain(messages);
    ChannelMessage.countDocuments.mockResolvedValue(2);

    const res = await request(app)
      .get(`/channels/${CHANNEL_ID}/messages`)
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(messages.map((m) => ({
      ...m,
      createdAt: m.createdAt.toISOString(),
    })));
    expect(res.body.page).toBe(1);
    expect(res.body.limit).toBe(100);
    expect(res.body.total).toBe(2);

    expect(ChannelMessage.find).toHaveBeenCalledWith({ channelId: CHANNEL_ID });
    expect(chain.skip).toHaveBeenCalledWith(0);
    expect(chain.limit).toHaveBeenCalledWith(100);
  });

  test('pagination: page/limit query params are honored and limit is capped at 100', async () => {
    isMember.mockResolvedValue(true);
    const chain = mockFindChain([]);
    ChannelMessage.countDocuments.mockResolvedValue(0);

    const res = await request(app)
      .get(`/channels/${CHANNEL_ID}/messages`)
      .query({ page: 3, limit: 9999 })
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.page).toBe(3);
    expect(res.body.limit).toBe(100); // capped at MAX_LIMIT
    expect(chain.skip).toHaveBeenCalledWith(200); // (page-1) * limit = 2 * 100
    expect(chain.limit).toHaveBeenCalledWith(100);
  });

  test('403 for a non-member', async () => {
    isMember.mockResolvedValue(false);

    const res = await request(app)
      .get(`/channels/${CHANNEL_ID}/messages`)
      .set(authHeader());

    expect(res.status).toBe(403);
    expect(ChannelMessage.find).not.toHaveBeenCalled();
  });

  test('404 for an unknown channel', async () => {
    isMember.mockRejectedValue(new ChannelNotFoundError(CHANNEL_ID));

    const res = await request(app)
      .get(`/channels/${CHANNEL_ID}/messages`)
      .set(authHeader());

    expect(res.status).toBe(404);
    expect(ChannelMessage.find).not.toHaveBeenCalled();
  });

  test('401 when no token is provided', async () => {
    const res = await request(app).get(`/channels/${CHANNEL_ID}/messages`);

    expect(res.status).toBe(401);
    expect(isMember).not.toHaveBeenCalled();
  });
});
