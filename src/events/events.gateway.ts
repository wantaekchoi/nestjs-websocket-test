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

type Direction = 'up' | 'down' | 'left' | 'right' | 'up-right' | 'up-left' | 'down-right' | 'down-left';
type Moving = { direction: Direction; speed: 1 };
type MoveData = { moving: Moving };

type User = { id: string; state: State; moveQueue: MoveData[]; client?: Socket };

const ONE_MINUTE = 60 * 1000;
const ONE_HOUR = ONE_MINUTE * 60;
const UPDATE_STATE_INTERVAL_MS = 30;

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
    setInterval(this.removeInactiveUsers.bind(this), ONE_MINUTE);
    setInterval(this.updateAndBroadcastUsersState.bind(this), UPDATE_STATE_INTERVAL_MS);
  }

  private removeInactiveUsers() {
    const now = new Date();
    for (const id in this.users) {
      const user = this.users[id];
      const lastActivity = user.state.lastActivity;
      if (lastActivity) {
        const timeSinceLastActivity = now.getTime() - lastActivity.getTime();
        if (timeSinceLastActivity > ONE_HOUR) {
          user.client?.disconnect();
          this.removeUser(id);
        }
      }
    }
  }

  private updateAndBroadcastUsersState() {
    for (const id in this.users) {
      const user = this.users[id];
      if (user) {
        this.updateUserState(user);
      }
    }
    this.broadcastUsersState();
  }

  private broadcastUsersState() {
    const response = Object.values(this.users).map((user) => ({
      id: user.id,
      state: user.state,
    }));

    for (const id in this.users) {
      this.users?.[id]?.client?.emit('state', response);
    }
  }

  handleConnection(@ConnectedSocket() client: Socket) {
    const { id } = client;
    if (this.users[id]) {
      client.disconnect();
      this.removeUser(id);
    }

    const user = this.createUser(id, client);
    this.users[id] = user;
  }

  handleDisconnect(@ConnectedSocket() client: Socket) {
    const { id } = client;
    this.removeUser(id);
  }

  private removeUser(id: string) {
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
      moveQueue: [],
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
      'up-right': (position) => ({
        ...position,
        y: Math.min(position.y + 1, this.board.y.max),
        x: Math.min(position.x + 1, this.board.x.max),
      }),
      'up-left': (position) => ({
        ...position,
        y: Math.min(position.y + 1, this.board.y.max),
        x: Math.max(position.x - 1, this.board.x.min),
      }),
      'down-right': (position) => ({
        ...position,
        y: Math.max(position.y - 1, this.board.y.min),
        x: Math.min(position.x + 1, this.board.x.max),
      }),
      'down-left': (position) => ({
        ...position,
        y: Math.max(position.y - 1, this.board.y.min),
        x: Math.max(position.x - 1, this.board.x.min),
      }),
    };

  private updateUserState(user: User) {
    if (!user?.moveQueue?.[0]) return;

    const moveData = user.moveQueue.shift();

    if (!moveData?.moving) return;

    const {
      moving: { direction },
    } = moveData;

    const updateFunction = this.directionMap[direction];
    if (updateFunction) {
      user.state.position = updateFunction(user.state.position);
      user.state.lastActivity = new Date();
    }
  }

  @SubscribeMessage('move')
  onMoveEvent(
    @ConnectedSocket() client: Socket,
    @MessageBody() moveData: MoveData,
  ) {
    const { id } = client;
    const user = this.users[id];
    if (!user) {
      this.logger.error(`User not found: ${id}`);
      throw new Error('User not found');
    }

    user.moveQueue.push(moveData);
    user.state.lastActivity = new Date();
  }
}
