import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';

import { RaceGateway } from './race.gateway';
import { RaceRoomStore } from './race-room.store';
import { RaceService } from './race.service';

/**
 * Unit-level tests for the one thing the gateway owns that a socket-driven e2e
 * cannot cheaply assert every branch of: the **connection auth gate** (spec §1).
 * The full protocol conversation is exercised by `test/race-gateway.e2e-spec.ts`
 * over two real socket.io clients; here we prove missing/invalid/valid tokens in
 * isolation, with the collaborators mocked.
 */
describe('RaceGateway connection auth', () => {
  const secret = 'unit-access-secret-at-least-32-characters-long';

  const buildGateway = (jwt: Partial<JwtService>) => {
    const service = {
      findActiveRaceForUser: jest.fn().mockResolvedValue(null),
    } as unknown as RaceService;
    const rooms = {} as RaceRoomStore;
    const config = { get: () => secret } as unknown as ConfigService;
    const gateway = new RaceGateway(service, rooms, jwt as JwtService, config as never);
    // The gateway reads `this.server` only after connect succeeds; a stub is enough.
    (gateway as unknown as { server: unknown }).server = {
      in: () => ({ fetchSockets: () => Promise.resolve([]) }),
    };
    return { gateway, service };
  };

  const fakeSocket = (auth: Record<string, unknown>, headers: Record<string, string> = {}) => {
    const emit = jest.fn();
    const disconnect = jest.fn();
    const join = jest.fn().mockResolvedValue(undefined);
    return {
      socket: {
        id: 'sock-1',
        data: {} as { userId?: string; raceId?: string },
        handshake: { auth, headers },
        emit,
        disconnect,
        join,
      } as never,
      emit,
      disconnect,
      join,
    };
  };

  it('refuses a socket with no token and disconnects it', async () => {
    const jwt = { verifyAsync: jest.fn() };
    const { gateway } = buildGateway(jwt);
    const { socket, disconnect, emit } = fakeSocket({});

    await gateway.handleConnection(socket);

    expect(jwt.verifyAsync).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith(
      'race:error',
      expect.objectContaining({ code: 'unauthorized' }),
    );
    expect(disconnect).toHaveBeenCalledWith(true);
    expect((socket as { data: { userId?: string } }).data.userId).toBeUndefined();
  });

  it('refuses a socket whose token fails verification', async () => {
    const jwt = { verifyAsync: jest.fn().mockRejectedValue(new Error('bad signature')) };
    const { gateway } = buildGateway(jwt);
    const { socket, disconnect } = fakeSocket({ token: 'garbage' });

    await gateway.handleConnection(socket);

    expect(disconnect).toHaveBeenCalledWith(true);
  });

  it('accepts a valid token, stamps the userId, and joins the per-user room', async () => {
    const jwt = { verifyAsync: jest.fn().mockResolvedValue({ sub: 'user-42' }) };
    const { gateway } = buildGateway(jwt);
    const { socket, disconnect, join } = fakeSocket({ token: 'good-jwt' });

    await gateway.handleConnection(socket);

    expect(disconnect).not.toHaveBeenCalled();
    expect((socket as { data: { userId?: string } }).data.userId).toBe('user-42');
    expect(join).toHaveBeenCalledWith('user:user-42');
  });

  it('falls back to the Authorization: Bearer header when auth.token is absent', async () => {
    const jwt = { verifyAsync: jest.fn().mockResolvedValue({ sub: 'user-7' }) };
    const { gateway } = buildGateway(jwt);
    const { socket } = fakeSocket({}, { authorization: 'Bearer header-jwt' });

    await gateway.handleConnection(socket);

    expect(jwt.verifyAsync).toHaveBeenCalledWith('header-jwt', { secret });
    expect((socket as { data: { userId?: string } }).data.userId).toBe('user-7');
  });

  it('refuses a token that verifies but carries no subject', async () => {
    const jwt = { verifyAsync: jest.fn().mockResolvedValue({}) };
    const { gateway } = buildGateway(jwt);
    const { socket, disconnect } = fakeSocket({ token: 'no-sub' });

    await gateway.handleConnection(socket);

    expect(disconnect).toHaveBeenCalledWith(true);
  });
});
