import { Logger } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  WsResponse,
} from '@nestjs/websockets';
import { from, Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { Server, Socket } from 'socket.io';

type Position = { x: number; y: number; z: 0 };
type State = { position: Position; lastActivity?: Date };

type Direction = 'up' | 'down' | 'left' | 'right';
type Moving = { direction: Direction; speed: 1 };
type Data = { moving: Moving };

type User = { id: string; state: State; queue: Data[]; client?: Socket };
type UserModel = { id: string; state: State };

@WebSocketGateway({
  cors: {
    origin: '*',
  },
})
export class EventsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private logger = new Logger('EventsGateway');

  private users: { [id: string]: User } = {};

  private board = {
    x: { min: -10, max: 10, default: 0 },
    y: { min: -10, max: 10, default: 0 },
    z: { min: 0 as 0, max: 0 as 0, default: 0 as 0 },
  };

  @WebSocketServer()
  server: Server;

  constructor() {
    setInterval(this.cleanupInactiveUsers.bind(this), 60 * 1000); // 1분마다 실행
  }

  private cleanupInactiveUsers() {
    const now = new Date();
    for (const id in this.users) {
      const lastActivity = this.users[id].state.lastActivity;
      if (lastActivity) {
        const diff = now.getTime() - lastActivity.getTime();
        if (diff > 60 * 60 * 1000) {
          this.users[id].client?.disconnect();
          this.deleteUser(id);
        }
      }
    }
  }

  handleConnection(@ConnectedSocket() client: Socket) {
    const { id } = client;
    if (this.users[id]) {
      client.disconnect();
      this.deleteUser(id);
    }

    const user = this.createUser(id, client);
    this.users[id] = user;

    for (const id in this.users) {
      const user = this.users?.[id];
      client.emit('state', {
        id: user.id,
        state: user.state,
      });
    }
  }

  handleDisconnect(@ConnectedSocket() client: Socket) {
    const { id } = client;
    this.deleteUser(id);
  }

  private deleteUser(id: string) {
    delete this.users?.[id];
  }

  private createUser(id: string, client: Socket): User {
    const {
      x: { default: x },
      y: { default: y },
      z: { default: z },
    } = this.board;
    const position: Position = { x, y, z };
    return {
      id: id,
      state: { position, lastActivity: new Date() },
      queue: [],
      client,
    };
  }

  private directionMap: {
    [direction in Direction]: (position: Position) => Position;
  } = {
    up: (position) => ({
      ...position,
      y: Math.min(position.y + 1, this.board.y.max),
    }),
    down: (position) => ({
      ...position,
      y: Math.max(position.y - 1, this.board.y.min),
    }),
    left: (position) => ({
      ...position,
      x: Math.max(position.x - 1, this.board.x.min),
    }),
    right: (position) => ({
      ...position,
      x: Math.min(position.x + 1, this.board.x.max),
    }),
  };

  private updateUserState(user: User): User {
    const data = user.queue.shift();

    if (!data?.moving) return user;

    const {
      moving: { direction },
    } = data;

    const updateFunction = this.directionMap[direction];
    if (updateFunction) {
      user.state.position = updateFunction(user.state.position);
      user.state.lastActivity = new Date();
    }

    return user;
  }

  @SubscribeMessage('move')
  onMoveEvent(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: Data,
  ): Observable<WsResponse<UserModel>> {
    const { id } = client;
    const user = this.users[id];
    if (!user) {
      this.logger.error(`User not found: ${id}`);
      throw new Error('user not found');
    }

    user.queue.push(data);
    user.state.lastActivity = new Date();

    for (const id in this.users) {
      this.users[id] = this.updateUserState(this.users[id]);
    }

    const event = 'state';
    const response = Object.values(this.users).map((user) => ({
      id: user.id,
      state: user.state,
    }));

    return from(response).pipe(map((data) => ({ event, data })));
  }
}
