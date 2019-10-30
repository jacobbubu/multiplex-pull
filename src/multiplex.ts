import { EventEmitter } from 'events'
import * as pull from 'pull-stream'
import xtend = require('xtend')
import varint = require('varint')
import { pushable, Read } from '@jacobbubu/pull-pushable'

import { Debug } from '@jacobbubu/debug'

import { Channel, ChannelOptions, ChannelId, ChannelDataType } from './channel'

export interface MultiplexOptions {
  binaryName?: Buffer
  limit?: number
}

export type Payload = Buffer
export type Header = number

const SIGNAL_FLUSH = Buffer.from([0])

const EMPTY = Buffer.alloc(0)
let pool = Buffer.alloc(10 * 1024)
let used = 0

enum PlexState {
  Initial = 0,
  HeaderReady,
  DataReady
}

type OnChannel = (channel: Channel, name: string) => any

const getPlexName = (function() {
  let counter = 1
  return () => (counter++).toString()
})()

const DefaultLogger = Debug.create('plex')

class Multiplex extends EventEmitter {
  private _source: Read<Payload> | undefined

  private _local: (Channel | null)[] = []
  private _remote: (Channel | null)[] = []
  private _list: (Channel | null)[] = []

  private _options: MultiplexOptions
  private _binaryName: boolean

  private limit = 0

  private _state: PlexState = PlexState.Initial
  private _type: ChannelDataType = ChannelDataType.Initial
  private _channel: ChannelId = 0
  private _missing: number = 0
  private _buf: Buffer
  private _ptr = 0
  private _message: Payload | null = null
  private _chunked = false
  private _finished = false

  public destroyed = false

  readonly plexName: string
  public logger: Debug

  constructor(opts?: MultiplexOptions | null, onchannel?: OnChannel) {
    super()
    // tslint:disable-next-line:strict-type-predicates
    if (typeof opts === 'function') {
      onchannel = opts
      opts = {}
    } else {
      opts = opts || {}
    }
    if (onchannel) {
      this.on('stream', onchannel)
    }

    this._options = opts
    this._binaryName = !!opts.binaryName
    this.limit = opts.limit || 0
    this._buf = Buffer.alloc(this.limit ? varint.encodingLength(this.limit) : 100)
    this._list = this._local
    this.plexName = getPlexName()
    this.logger = DefaultLogger.ns(this.plexName)
  }

  _clear() {
    if (this._finished) return
    this._finished = true

    const list = this._local.concat(this._remote)

    this._local = []
    this._remote = []

    list.forEach(function(stream) {
      if (stream) stream.destroy(null, false)
    })
    this.source.end()
  }

  private _name(name: string) {
    if (!this._binaryName) {
      return name.toString()
    }
    return Buffer.isBuffer(name) ? name : Buffer.from(name)
  }

  public get source() {
    if (!this._source) {
      this._source = pushable()
    }
    return this._source
  }

  public abort(err?: Error) {
    this.destroyed = true
    this._clear()
    return
  }

  // sink 相当于stream.writable 的实现，即处理对端传入的数据
  public sink: pull.Sink<Payload> = read => {
    const self = this
    read(null, function next(endOrError, data) {
      if (true === endOrError) {
        self.logger.log('ended by upstream, say SOCKET?')
        self.abort()
        return
      }
      if (endOrError) {
        self.logger.error('upstream errors:', endOrError)
        self.abort(endOrError)
        return
      }
      // process data
      if (data === SIGNAL_FLUSH) return

      let offset = 0
      while (offset < data.length) {
        if (self._state === PlexState.DataReady) {
          offset = self._writeMessage(data, offset)
        } else {
          // 每次 _writeVarint 读到 Int，PlexState 都会进一步
          offset = self._writeVarint(data, offset)
        }
      }
      // 如果 data 拿全了
      if (self._state === PlexState.DataReady && !self._missing) {
        self._pushToChannel(EMPTY)
      }

      // read again
      read(self.destroyed || null, next)
    })

    return undefined
  }

  public createChannel(name?: string, opts?: ChannelOptions) {
    if (this.destroyed) throw new Error('Multiplexer is destroyed')

    let id = this._local.indexOf(null)
    if (id === -1) {
      id = this._local.push(null) - 1
    }

    if (typeof name !== 'string') {
      name = id.toString()
      opts = name as ChannelOptions
    } else {
      name || id.toString()
    }

    const channel = new Channel(this._name(name), this, xtend(this._options, opts))
    return this._addChannel(channel, id, this._local)
  }

  public receiveStream(name: string, opts: ChannelOptions) {
    return
  }

  private _addChannel(channel: Channel, id: number, list: (Channel | null)[]) {
    while (list.length <= id) list.push(null)
    list[id] = channel

    channel.open(id, list === this._local)
    return channel
  }

  public pushToSource(header: Header, data?: Payload) {
    this.logger.debug('pushToSource', `@${this.plexName}`, { header, v: data && data.toString() })
    const dataLength = data ? data.length : 0
    const oldUsed = used

    // [header = channelId << 3 | channelDataType, dataLength, data? ])
    varint.encode(header, pool, used)
    used += varint.encode.bytes

    varint.encode(dataLength, pool, used)
    used += varint.encode.bytes

    this.source.push(pool.slice(oldUsed, used))

    if (pool.length - used < 100) {
      pool = Buffer.alloc(10 * 1024)
      used = 0
    }

    if (data) {
      this.source.push(data)
    }
  }

  private _lengthError(data: Payload) {
    this.abort(new Error(`Incoming message(length = ${data.length}) is too big`))
    return data.length
  }

  private _writeMessage(data: Payload, offset: number) {
    const free = data.length - offset
    const missing = this._missing

    if (!this._message) {
      if (missing <= free) {
        // fast track - no copy
        this._missing = 0
        this._pushToChannel(data.slice(offset, offset + missing))
        return offset + missing
      }
      if (this._chunked) {
        this._missing -= free
        this._pushToChannel(data.slice(offset, data.length))
        return data.length
      }
      this._message = Buffer.alloc(missing)
    }

    data.copy(this._message, this._ptr, offset, offset + missing)

    if (missing <= free) {
      this._missing = 0
      this._pushToChannel(this._message)
      return offset + missing
    }

    this._missing -= free
    this._ptr += free

    return data.length
  }

  private _writeVarint(data: Payload, offset: number) {
    for (offset; offset < data.length; offset++) {
      if (this._ptr === this._buf.length) {
        return this._lengthError(data)
      }
      this._buf[this._ptr++] = data[offset]
      if (!(data[offset] & 0x80)) {
        // gpt an integer
        if (this._state === PlexState.Initial) {
          // it's a first integer in header, so extract the channelId
          const header = varint.decode(this._buf)
          this._type = header & 7
          this._channel = header >> 3
          this._list = this._type & 1 ? this._local : this._remote
          const chunked = !!(
            this._list.length > this._channel &&
            this._list[this._channel] &&
            this._list[this._channel]!.chunked
          )
          this._chunked =
            !!(
              this._type === ChannelDataType.LocalPacket ||
              this._type === ChannelDataType.RemotePacket
            ) && chunked
        } else {
          // the second integer represents the length of following data
          this._missing = varint.decode(this._buf)
          if (this.limit && this._missing > this.limit) {
            return this._lengthError(data)
          }
        }
        // step up the state Initial -> HeaderReady or HeaderReady -> DataReady
        this._state++
        this._ptr = 0
        return offset + 1
      }
    }
    return data.length
  }

  // _push 是把收到的数据“具象化”的过程
  private _pushToChannel(data: Payload) {
    if (!this._missing) {
      this._ptr = 0
      this._state = PlexState.Initial
      this._message = null
    }

    if (this._type === ChannelDataType.Initial) {
      if (this.destroyed) return

      const name = this._binaryName ? data : data.toString() || this._channel.toString()

      const channel = new Channel(name, this, this._options)
      this.logger.debug('Create remote channel:', name)
      this.emit('stream', this._addChannel(channel, this._channel, this._list), channel.name)
      return
    }

    const channel = this._list[this._channel]
    if (!channel) return

    switch (this._type) {
      case ChannelDataType.LocalError:
      case ChannelDataType.RemoteError:
        this.logger.debug(
          '_pushToChannel, %s, %B',
          ChannelDataType.LocalError === this._type ? 'LocalError' : 'RemoteError',
          data
        )
        channel.destroy(new Error(data.toString() || 'Channel destroyed'), false)
        return

      case ChannelDataType.LocalEnd:
      case ChannelDataType.RemoteEnd:
        this.logger.debug(
          '_pushToChannel, %s, %B',
          ChannelDataType.LocalEnd === this._type ? 'LocalEnd' : 'RemoteEnd',
          data
        )
        channel.source.end()
        return

      case ChannelDataType.LocalPacket:
      case ChannelDataType.RemotePacket:
        // 此处该给 channel 推入数据
        this.logger.debug(
          '_pushToChannel, %s, %B',
          ChannelDataType.LocalPacket === this._type ? 'LocalPacket' : 'RemotePacket',
          data
        )
        channel.push(data)
        // channel end
        // this._awaitChannelDrains++;
        // stream._awaitDrain++;
        return
    }

    return
  }
}

export function dumpSinkData(endOrError: boolean | Error | null, data?: Buffer) {
  const o = endOrError
    ? { endOrError, data: data && data.toString() }
    : { data: data && data.toString() }
  return JSON.stringify(o)
}

export { Multiplex }
