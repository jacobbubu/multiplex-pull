import * as pull from 'pull-stream'
import { Multiplex, Channel } from '../src'

const link = (p1: any, p2: any) => {
  pull(p1.source, p2.sink)
  pull(p2.source, p1.sink)
}

/**
 * Dummy test
 */
describe('multiplex', () => {
  it('create a channel', done => {
    const plex1 = new Multiplex()

    const plex2 = new Multiplex(null, (channel: Channel, name: string) => {
      pull(
        channel.source,
        pull.collect((err, result) => {
          expect(err).toBeFalsy()
          expect(result.toString()).toEqual('plex1')
          done()
        })
      )

      // write back to peer
      pull(pull.values(['plex2']), channel.sink)
    })

    link(plex1, plex2)

    const channelAt1 = plex1.createChannel()

    pull(
      channelAt1.source,
      pull.collect((err, result) => {
        expect(err).toBeFalsy()
        expect(result.toString()).toEqual('plex2')
      })
    )

    pull(pull.values(['plex1']), channelAt1.sink)
  })
})
