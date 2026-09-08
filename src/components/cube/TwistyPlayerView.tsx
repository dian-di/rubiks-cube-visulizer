// 立体魔方视图：封装 cubing 的 <twisty-player> 自定义元素，并通过 store 的
// moveToken / playerClearToken 事件与 2D 同心圆投影实时同步播放同一手转动。

import { useEffect, useRef } from 'react'
import type * as React from 'react'
import 'cubing/twisty'
import { useCubeStore } from '@/store/cubeStore'

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'twisty-player': React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & {
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

// 4 阶宽两层记号：本项目用 WCA 小写（u/d/l/r/f/b），cubing 用大写 + w（Uw/Dw/Lw/Rw/Fw/Bw）。
// 注意：cubing 的 4x4x4 把 Uv/Rv 等当作「整体重新定向」（整魔方转动，所有块移动），
// 只有 Uw/Rw 才是真正的宽两层转动（切割上两层），因此这里必须映射成 w 而非 v。
// 2/3 阶的记号（U/M 等）本身已是 cubing 记法，原样透传。
const WIDE_TO_TWISTY: Record<string, string> = {
  u: 'Uw',
  d: 'Dw',
  l: 'Lw',
  r: 'Rw',
  f: 'Fw',
  b: 'Bw',
}
function toTwistyMove(order: number, token: string): string {
  if (order !== 4) return token
  const prime = token.endsWith("'")
  const base = prime ? token.slice(0, -1) : token
  const wide = WIDE_TO_TWISTY[base]
  return wide ? (prime ? `${wide}'` : wide) : token
}

export function TwistyPlayerView() {
  const playerRef = useRef<HTMLElement | null>(null)
  // 订阅 3D 播放器事件：moveToken 变化 → 播放 lastMove；playerClearToken 变化 → 清空 alg。
  const moveToken = useCubeStore((s) => s.moveToken)
  const lastMove = useCubeStore((s) => s.lastMove)
  const playerClearToken = useCubeStore((s) => s.playerClearToken)
  const order = useCubeStore((s) => s.order)

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

  // 阶数切换：把对应阶的 puzzle 同步给立体魔方（2→'2x2x2'，3→'3x3x3'，4→'4x4x4'）。
  // cubing 的 <twisty-player> 通过 puzzle 属性重建内部模型；切阶时已通过
  // playerClearToken 清空 alg，这里再重设 puzzle 即可保持一致。
  useEffect(() => {
    void getPlayerReady().then(() => {
      const p = playerRef.current as any
      if (!p) return
      try {
        p.puzzle = order === 2 ? '2x2x2' : order === 4 ? '4x4x4' : '3x3x3'
      } catch {
        // ignore
      }
    })
  }, [order])

  // 每次转动：把同一手同步播放到立体魔方（异步，不阻塞 2D 动画）。
  useEffect(() => {
    if (moveToken === 0) return
    void getPlayerReady().then(() => {
      const p = playerRef.current as any
      if (!p || typeof p.experimentalAddMove !== 'function') return
      try {
        p.experimentalAddMove(toTwistyMove(order, lastMove))
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
