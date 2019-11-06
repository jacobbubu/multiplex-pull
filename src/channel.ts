import { EventEmitter } from 'events'
import * as pull from 'pull-stream'
import { pushable, Read } from '@jacobbubu/pull-pushable'
import { Debug } from '@jacobbubu/debug'

import { Multiplex, MultiplexOptions, Payload } from './multiplex'

export interface ChannelOptions extends MultiplexOptions {
  chunked?: boolean
}

export type ChannelId = number

export enum ChannelDataType {
  Initial = 0,
  LocalPacket,
  RemotePacket,
  LocalEnd,
  RemoteEnd,
  LocalError,
  RemoteError
}

export class Channel extends EventEmitter {
  public channel: ChannelId = 0
  public initiator = false
  public chunked = false

  private _source: Read<Payload> | undefined
  private _dataHeader = 0
  private _opened = false
  private logger: Debug
  private _ended = false
  private _abort = false

  constructor(
    public name: Buffer | string,
    private _multiplex: Multiplex,
    opts: ChannelOptions = {}
  ) {
    super()
    this.name = name
    this.chunked = !!opts.chunked
    this.logger = _multiplex.logger.ns(this.name.toString())

    // 我先不处理单双工的关闭逻辑
  }

  public get source() {
    if (!this._source) {
      const self = this
      this._source = pushable(() => {
        self._ended = true
        self.logger.debug('Channel.source ended')
      })
    }
    return this._source
  }

  public push(data: Payload) {
    this.source.push(data)
    this.logger.debug('channel pushed: %o', {
      initiator: this.initiator,
      v: data && data.toString()
    })
  }

  public destroy(err: Error | null, local: boolean) {
    if (this._abort) return
    this._abort = true

    this.source.end()

    // send error to peer if there is a local error

    if (local && this._opened) {
      try {
        this._multiplex.pushToSource(
          (this.channel << 3) |
            (this.initiator ? ChannelDataType.RemoteError : ChannelDataType.LocalError),
          err ? Buffer.from(err.message) : undefined
        )
      } catch (e) {
        /* */
      }
    }
    return
  }

  public sink: pull.Sink<Buffer> = read => {
    if (!this._opened) {
      this.logger.warn('Channel has not open yet')
      return
    }
    const self = this
    read(this._abort || null, function next(endOrError, data) {
      self.logger.debug('channel read from upstream %o', { endOrError, data })
      // no more data from upstream to channel
      if (true === endOrError) {
        self.logger.debug('upstream ended, %o', { initiator: self.initiator })

        // tell peer that we're going to end this channel
        self._multiplex.pushToSource(
          // 3: local end; 4: remote end
          (self.channel << 3) |
            (self.initiator ? ChannelDataType.RemoteEnd : ChannelDataType.LocalEnd)
        )
        self._ended = true
        return
      }
      // we may need to propagate the error
      if (endOrError) {
        self.logger.error('Upstream errors: %o', { initiator: self.initiator, error: endOrError })
        self._ended = true
        return
      }

      self.logger.debug(
        `Data the channel's read: %o, %B`,
        {
          initiator: self.initiator,
          dataHeader: self._dataHeader
        },
        data
      )

      if (!Buffer.isBuffer(data)) {
        switch (typeof data) {
          case 'string':
            data = Buffer.from(data)
            break
          default:
            throw new Error(`unsupported value type(${typeof data}: ${data})`)
        }
      }
      // pass-through upstream's data to remote peer
      self._multiplex.pushToSource(self._dataHeader, data)
      read(self._abort || null, next)
    })

    return undefined
  }

  public open(channel: ChannelId, initiator: boolean) {
    this.channel = channel
    this.initiator = initiator
    if (!initiator) {
      this.logger = this._multiplex.logger.ns(this.name.toString() + "'")
    }

    this._dataHeader =
      (channel << 3) | (initiator ? ChannelDataType.RemotePacket : ChannelDataType.LocalPacket)
    this._opened = true

    if (this.initiator) this._open()

    this.emit('open')
  }

  private _open() {
    let buf
    if (Buffer.isBuffer(this.name)) {
      buf = this.name
    } else if (this.name !== this.channel.toString()) {
      buf = Buffer.from(this.name)
    }

    this._multiplex.pushToSource((this.channel << 3) | 0, buf)
  }
}
