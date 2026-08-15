#!/usr/bin/env node

import { main } from '../src/launcher.js'

process.exitCode = await main(process.argv.slice(2))
