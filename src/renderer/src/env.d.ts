/// <reference types="vite/client" />

import type { KoibillApi } from '../../shared/types'

declare global {
  interface Window {
    koibill: KoibillApi
  }
}

export {}
