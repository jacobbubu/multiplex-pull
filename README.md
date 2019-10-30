# @jacobbubu/multiplex-pull

[![Build Status](https://travis-ci.org/jacobbubu/multiplex-pull.svg)](https://travis-ci.org/NXMIX/jacobbubu/multiplex-pull)
[![Coverage Status](https://coveralls.io/repos/github/NXMIX/jacobbubu/multiplex-pull/badge.svg)](https://coveralls.io/github/jacobbubu/multiplex-pull)
[![npm](https://img.shields.io/npm/v/@jacobbubu/multiplex-pull.svg)](https://www.npmjs.com/package/@jacobbubu/multiplex-pull/)

> A [multiplex](https://github.com/maxogden/multiplex) impementation that uses [pull-stream](https://github.com/pull-stream/pull-stream).

### Usage

```bash
npm install @jacobbubu/multiplex-pull
npm run example.ex1
```

```ts
import * as pull from 'pull-stream'
import { Multiplex, Channel } from '@jacobbubu/multiplex-pull'

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
})

pull(p1.source, p2.sink)
pull(p2.source, p1.sink)

pull(pull.values(['plex1']), channelAt1.sink)
```
