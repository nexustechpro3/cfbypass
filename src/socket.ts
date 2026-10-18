import { Server as IOServer } from 'socket.io'
import { io as ioClient } from 'socket.io-client'
import type { Server } from 'http'

export function attachSocketRelay(httpServer: Server): void {
    const io = new IOServer(httpServer, {
        path: '/socket-relay',
        cors: { origin: '*', methods: ['GET', 'POST'] },
        transports: ['websocket', 'polling'],
    })

    io.use((socket, next) => {
        const pwd = socket.handshake.headers['x-proxy-password'] as string
        if (!pwd || pwd !== process.env.SERVER_PROXY_PASSWORD) {
            return next(new Error('Unauthorized'))
        }
        next()
    })

    io.on('connection', socket => {
        const target = socket.handshake.headers['x-proxy-target'] as string
        const path = socket.handshake.headers['x-proxy-path'] as string | undefined
        const cookie = socket.handshake.headers['x-proxy-cookie'] as string | undefined
        const ua = socket.handshake.headers['x-proxy-ua'] as string | undefined
        const origin = socket.handshake.headers['x-proxy-origin'] as string | undefined
        const referer = socket.handshake.headers['x-proxy-referer'] as string | undefined
        const query = socket.handshake.query

        if (!target) {
            socket.disconnect()
            return
        }

        const upstream = ioClient(target, {
            path: path ?? '/socket.io/',
            transports: ['websocket', 'polling'],
            query,
            extraHeaders: {
                ...(cookie && { 'Cookie': cookie }),
                ...(ua && { 'User-Agent': ua }),
                ...(origin && { 'Origin': origin }),
                ...(referer && { 'Referer': referer }),
            },
            reconnection: false,
        })

        upstream.onAny((event, ...args) => socket.emit(event, ...args))
        socket.onAny((event, ...args) => { if (upstream.connected) upstream.emit(event, ...args) })

        upstream.on('connect', () => { console.log(`[SocketRelay] upstream connected → ${target} | query:`, JSON.stringify(query)) })
        upstream.on('connect_error', e => { console.error('[SocketRelay] upstream error:', e.message); socket.disconnect() })
        upstream.on('disconnect', reason => { console.warn('[SocketRelay] upstream disconnected:', reason); socket.disconnect() })
        socket.on('disconnect', () => upstream.disconnect())
    })

    console.log('[SocketRelay] Attached on path /socket-relay')
}