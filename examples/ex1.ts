// process.env.DEBUG = 'plex*'
// process.env.DEBUG_LOG_LEVEL = 'info'
// process.env.DEBUG_NAME_WIDTH = '12'

import * as pull from 'pull-stream'
import { Debug } from '@jacobbubu/debug'
import { Multiplex, Channel } from '../src'

const link = (p1: any, p2: any) => {
  pull(p1.source, p2.sink)
  pull(p2.source, p1.sink)
}

const logger = Debug.create('plex:ex1')

function output(label: string) {
  const sinkLogger = logger.ns(label)

  return (read: pull.Source<Buffer>) => {
    read(null, function next(endOrError, data) {
      if (true === endOrError) {
        sinkLogger.debug('Ended')
        return
      }

      if (endOrError) {
        sinkLogger.error('Error: %o', endOrError)
        throw endOrError
      }
      sinkLogger.info(`Data received at (${label}): %B`, data)
      read(null, next)
    })

    return undefined
  }
}

const plex1 = new Multiplex(null, (channel: Channel, name: string) => {
  logger.info(`A new channel('${name}') comes to plex1`)

  pull(channel.source, output(`${channel.name.toString()}'`))
})

const plex2 = new Multiplex(null, (channel: Channel, name: string) => {
  logger.info(`A new channel('${name}') comes to plex2`)

  pull(channel.source, output(`${channel.name.toString()}'`))

  // write back to peer
  pull(pull.values(['plex2']), channel.sink)
})

link(plex1, plex2)

const channelAt1 = plex1.createChannel()

pull(channelAt1.source, output(channelAt1.name.toString()))

pull(pull.values(['plex1']), channelAt1.sink)
