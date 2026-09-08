// 立体魔方视图：封装 cubing 的 <twisty-player> 自定义元素，并通过 store 的
// moveToken / playerClearToken 事件与 2D 同心圆投影实时同步播放同一手转动。

import { useEffect, useRef } from 'react'
import type { DetailedHTMLProps, HTMLAttributes } from 'react'
import 'cubing/twisty'
import { useCubeStore } from '@/store/cubeStore'

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'twisty-player': DetailedHTMLProps<
        HTMLAttributes<HTMLElement> & {
          alg?: string
          controlPanel?: string
          background?: string
          tempoScale?: number
          cameraLatitude?: number
          cameraLongitude?: number
        },
        HTMLElement
      >
    }
  }
}

const TURN_MS = 420

export function TwistyPlayerView() {
  const playerRef = useRef<HTMLElement | null>(null)
  // 订阅 3D 播放器事件：moveToken 变化 → 播放 lastMove；playerClearToken 变化 → 清空 alg。
  const moveToken = useCubeStore((s) => s.moveToken)
  const lastMove = useCubeStore((s) => s.lastMove)
  const playerClearToken = useCubeStore((s) => s.playerClearToken)

  const getPlayerReady = () => customElements.whenDefined('twisty-player')

  // 3D 播放器：等 custom element 升级完再写属性，避免属性被 own-property 影子覆盖。
  useEffect(() => {
    let cancelled = false
    void getPlayerReady().then(() => {
      if (cancelled) return
      const p = playerRef.current as any
      if (!p) return
      p.controlPanel = 'none'
      p.background = 'auto'
      p.tempoScale = 500 / TURN_MS
      p.cameraLatitude = 28
      p.cameraLongitude = 30
    })
    return () => {
      cancelled = true
    }
  }, [])

  // 每次转动：把同一手同步播放到立体魔方（异步，不阻塞 2D 动画）。
  useEffect(() => {
    if (moveToken === 0) return
    void getPlayerReady().then(() => {
      const p = playerRef.current as any
      if (!p || typeof p.experimentalAddMove !== 'function') return
      try {
        p.experimentalAddMove(lastMove)
      } catch {
        // ignore
      }
    })
  }, [moveToken, lastMove])

  // 复位：清空立体魔方的 alg。
  useEffect(() => {
    if (playerClearToken === 0) return
    void getPlayerReady().then(() => {
      const p = playerRef.current as any
      if (!p) return
      try {
        p.alg = ''
      } catch {
        // ignore
      }
    })
  }, [playerClearToken])

  return (
    <twisty-player
      alg=''
      ref={playerRef}
      // 不要加 block：cubing 依赖宿主元素的 display:grid 让 shadow root 的根节点撑满高度。
      className='h-full w-full'
      style={{ width: '100%', height: '100%', minHeight: 128 }}
    />
  )
}
