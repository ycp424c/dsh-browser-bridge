import { setup, sdkConfig } from './dsh-sdk.mjs'
const { runtime, source, extras } = sdkConfig()
setup([runtime, source, ...extras])
