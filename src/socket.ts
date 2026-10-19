import { Server as IOServer } from 'socket.io'
import { io as ioClient } from 'socket.io-client'
import type { Server } from 'http'

export function attachSocketRelay(httpServer: Server): void {
    const io = new IOServer(httpServer, {
        path: '/socket-relay',
        cors: { origin: '*', methods: ['GET', 'POST'] },
        transports: ['websocket', 'polling'],
    })

    const relay = io.of(/.*/)

    relay.use((socket, next) => {
        const pwd = socket.handshake.headers['x-proxy-password'] as string
        console.log(`[SocketRelay] auth attempt | pwd provided: ${!!pwd}`)
        if (!pwd || pwd !== process.env.SERVER_PROXY_PASSWORD) {
            console.error('[SocketRelay] auth FAILED — wrong or missing password')
            return next(new Error('Unauthorized'))
        }
        console.log('[SocketRelay] auth OK')
        next()
    })

    relay.on('connection', socket => {
        const target = socket.handshake.headers['x-proxy-target'] as string
        const path = socket.handshake.headers['x-proxy-path'] as string | undefined
        const cookie = socket.handshake.headers['x-proxy-cookie'] as string | undefined
        const ua = socket.handshake.headers['x-proxy-ua'] as string | undefined
        const origin = socket.handshake.headers['x-proxy-origin'] as string | undefined
        const referer = socket.handshake.headers['x-proxy-referer'] as string | undefined
        const namespace = socket.handshake.headers['x-proxy-namespace'] as string | undefined
        const query = socket.handshake.query

        console.log(`[SocketRelay] client connected | nsp: ${socket.nsp.name} | id: ${socket.id}`)
        console.log(`[SocketRelay] target: ${target} | namespace: ${namespace} | path: ${path}`)
        console.log(`[SocketRelay] query: ${JSON.stringify(query)}`)
        console.log(`[SocketRelay] cookie present: ${!!cookie} | ua present: ${!!ua}`)

        if (!target) {
            console.error('[SocketRelay] no target provided — disconnecting client')
            socket.disconnect()
            return
        }

        const upstreamUrl = `${target}${namespace ?? ''}`
        console.log(`[SocketRelay] connecting upstream → ${upstreamUrl} | path: ${path ?? '/socket.io/'}`)

        const upstream = ioClient(upstreamUrl, {
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

        upstream.on('connect', () => {
            console.log(`[SocketRelay] upstream CONNECTED ✅ → ${upstreamUrl} | id: ${upstream.id}`)
        })

        upstream.on('connect_error', (e: any) => {
            console.error(`[SocketRelay] upstream CONNECT ERROR ❌`)
            console.error(`  message: ${e.message}`)
            console.error(`  description: ${JSON.stringify(e.description)}`)
            console.error(`  context: ${JSON.stringify(e.context)}`)
            console.error(`  type: ${e.type}`)
            socket.disconnect()
        })

        upstream.on('disconnect', (reason: string) => {
            console.warn(`[SocketRelay] upstream DISCONNECTED ⚠️ reason: ${reason}`)
            socket.disconnect()
        })

        upstream.on('error', (e: any) => {
            console.error(`[SocketRelay] upstream ERROR ❌: ${e.message}`)
        })

        upstream.onAny((event: string, ...args: any[]) => {
            console.log(`[SocketRelay] upstream EVENT → client: ${event} | data: ${JSON.stringify(args).slice(0, 300)}`)
            socket.emit(event, ...args)
        })

        socket.onAny((event: string, ...args: any[]) => {
            console.log(`[SocketRelay] client EVENT → upstream: ${event} | data: ${JSON.stringify(args).slice(0, 300)}`)
            if (upstream.connected) {
                upstream.emit(event, ...args)
            } else {
                console.warn(`[SocketRelay] upstream not connected — dropping event: ${event}`)
            }
        })

        socket.on('disconnect', (reason: string) => {
            console.warn(`[SocketRelay] client DISCONNECTED ⚠️ reason: ${reason}`)
            upstream.disconnect()
        })

        socket.on('error', (e: any) => {
            console.error(`[SocketRelay] client ERROR ❌: ${e.message}`)
        })
    })

    console.log('[SocketRelay] Attached on path /socket-relay')
}