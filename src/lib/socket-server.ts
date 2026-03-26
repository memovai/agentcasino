import { Server as HttpServer } from 'http';
import { Server } from 'socket.io';
import { ServerToClientEvents, ClientToServerEvents } from './types';
import {
  initDefaultRooms, listRooms, joinRoom, leaveRoom,
  handleAction, tryStartGame, tryStartNextHand,
  getClientGameState, getRoom,
} from './room-manager';
import { claimChips, getOrCreateAgent, getAgent } from './chips';
import { saveMessage } from './casino-db';

let io: Server<ClientToServerEvents, ServerToClientEvents> | null = null;

// Track which agent is connected via which socket
const socketToAgent = new Map<string, string>();
const agentToSocket = new Map<string, string>();

export function getIO() { return io; }

export function initSocketServer(httpServer: HttpServer): Server {
  io = new Server(httpServer, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
    path: '/api/socketio',
  });

  initDefaultRooms();

  io.on('connection', (socket) => {
    console.log(`[Casino] Socket connected: ${socket.id}`);

    socket.on('rooms:list', () => {
      socket.emit('rooms:list', listRooms());
    });

    socket.on('chips:claim', ({ agentId }) => {
      const result = claimChips(agentId);
      socket.emit('chips:balance', result.chips);
      if (result.success) {
        socket.emit('chat:message', {
          agentId: 'system',
          name: '🎰 Casino',
          message: result.message,
          timestamp: Date.now(),
        });
      } else {
        socket.emit('error', result.message);
      }
    });

    socket.on('room:watch', ({ roomId, agentId }: { roomId: string; agentId?: string }) => {
      socket.join(roomId);
      // Register spectator so they can chat
      if (agentId) {
        socketToAgent.set(socket.id, agentId);
        agentToSocket.set(agentId, socket.id);
        getOrCreateAgent(agentId, agentId);
      }
      // Send current spectator state immediately
      const spectatorState = getClientGameState(roomId, '__spectator__');
      if (spectatorState) {
        socket.emit('game:state', spectatorState);
      }
    });

    socket.on('room:join', ({ roomId, agentId, buyIn }) => {
      // Register agent with socket
      const agent = getOrCreateAgent(agentId, agentId);
      socketToAgent.set(socket.id, agentId);
      agentToSocket.set(agentId, socket.id);

      const error = joinRoom(roomId, agentId, agent.name, buyIn);
      if (error) {
        socket.emit('error', error);
        return;
      }

      socket.join(roomId);

      // Broadcast updated room state
      broadcastRoomState(roomId);

      // Notify
      io!.to(roomId).emit('chat:message', {
        agentId: 'system',
        name: '🎰 Casino',
        message: `${agent.name} joined the table with ${buyIn.toLocaleString()} chips`,
        timestamp: Date.now(),
      });

      // Auto-start if enough players
      if (tryStartGame(roomId)) {
        broadcastGameState(roomId);
        io!.to(roomId).emit('chat:message', {
          agentId: 'system',
          name: '🎰 Casino',
          message: '🃏 New hand starting! Good luck!',
          timestamp: Date.now(),
        });
      }
    });

    socket.on('room:leave', ({ roomId }) => {
      const agentId = socketToAgent.get(socket.id);
      if (!agentId) return;

      leaveRoom(roomId, agentId);
      socket.leave(roomId);
      broadcastRoomState(roomId);

      const agent = getAgent(agentId);
      io!.to(roomId).emit('chat:message', {
        agentId: 'system',
        name: '🎰 Casino',
        message: `${agent?.name ?? agentId} left the table`,
        timestamp: Date.now(),
      });
    });

    socket.on('game:action', ({ roomId, action, amount }) => {
      const agentId = socketToAgent.get(socket.id);
      if (!agentId) {
        socket.emit('error', 'Not authenticated');
        return;
      }

      const error = handleAction(roomId, agentId, action, amount);
      if (error) {
        socket.emit('error', error);
        return;
      }

      const agent = getAgent(agentId);
      const actionStr = amount ? `${action} ${amount.toLocaleString()}` : action;
      io!.to(roomId).emit('game:action', {
        agentId,
        name: agent?.name ?? agentId,
        action: action as any,
        amount,
      });

      broadcastGameState(roomId);

      // Check if showdown — auto-start next hand after delay
      const room = getRoom(roomId);
      if (room?.game?.phase === 'showdown' && room.game.winners) {
        io!.to(roomId).emit('game:winners', room.game.winners);

        setTimeout(() => {
          if (tryStartNextHand(roomId)) {
            broadcastGameState(roomId);
            io!.to(roomId).emit('chat:message', {
              agentId: 'system',
              name: '🎰 Casino',
              message: '🃏 New hand starting!',
              timestamp: Date.now(),
            });
          }
        }, 5000);
      }
    });

    socket.on('chat:message', ({ roomId, message }) => {
      const agentId = socketToAgent.get(socket.id);
      if (!agentId) return;
      const agent = getAgent(agentId);
      const name = agent?.name ?? agentId;
      const timestamp = Date.now();

      io!.to(roomId).emit('chat:message', { agentId, name, message, timestamp });
      saveMessage(roomId, agentId, name, message);
    });

    socket.on('disconnect', () => {
      const agentId = socketToAgent.get(socket.id);
      if (agentId) {
        socketToAgent.delete(socket.id);
        agentToSocket.delete(agentId);
      }
      console.log(`[Casino] Socket disconnected: ${socket.id}`);
    });
  });

  return io;
}

function broadcastRoomState(roomId: string): void {
  if (!io) return;
  const room = getRoom(roomId);
  if (room) {
    io.to(roomId).emit('room:state', room);
  }
}

function broadcastGameState(roomId: string): void {
  if (!io) return;
  const room = getRoom(roomId);
  if (!room?.game) return;

  // Send personalized state to each player (they see their own cards only)
  for (const player of room.game.players) {
    const socketId = agentToSocket.get(player.agentId);
    if (socketId) {
      const state = getClientGameState(roomId, player.agentId);
      if (state) {
        io.to(socketId).emit('game:state', state);
      }
    }
  }

  // Send spectator view (no hole cards)
  const spectatorState = getClientGameState(roomId, '__spectator__');
  if (spectatorState) {
    // Broadcast to room but non-player sockets will get spectator view
    io.to(roomId).emit('game:state', spectatorState);
  }
}
