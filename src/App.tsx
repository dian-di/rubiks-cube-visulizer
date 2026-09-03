import type { MotionValue } from 'motion/react'
import { animate, motion, useMotionValue, useTransform } from 'motion/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import 'cubing/twisty'
import type { RefObject } from 'react'
import { Button } from '@/components/ui/button'

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'twisty-player': DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement>
    }
  }
}

// ---------------------------------------------------------------- types
type V3 = [number, number, number]
type Axis = 0 | 1 | 2

interface Pt {
  x: number
  y: number
}

interface Sticker {
  id: number
  pos: V3
  normal: V3
  color: string
}

interface AnimState {
  gen: number
  axis: Axis
  center: Pt
  // 绕 center 的极坐标：θ/r 各自线性插值，v=1 严格落在 place(next)，
  // 避免 motion CSS transform pipeline 的 transform-origin 覆盖问题。
  deltas: Map<number, { theta0: number; r0: number; theta1: number; r1: number }>
  next: Sticker[]
}

// ---------------------------------------------------------------- geometry
// 同心圆布局：Y 组在上方，X/Z 组在下排左右。三个半径对应层坐标 -1/0/+1。
const CENTERS: readonly [Pt, Pt, Pt] = [
  { x: 165, y: 290 }, // X
  { x: 250, y: 170 }, // Y
  { x: 335, y: 290 }, // Z
]
const RADII = [100, 124, 148]
const R = (v: number) => RADII[v + 1]
const AXIS_NAMES = ['X', 'Y', 'Z']

function circleIntersect(a: Pt, ra: number, b: Pt, rb: number): [Pt, Pt] | null {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const d = Math.hypot(dx, dy)
  if (d === 0 || d > ra + rb || d < Math.abs(ra - rb)) return null
  const t = (ra * ra - rb * rb + d * d) / (2 * d)
  const h2 = ra * ra - t * t
  if (h2 < 0) return null
  const h = Math.sqrt(h2)
  const bx = a.x + (dx * t) / d
  const by = a.y + (dy * t) / d
  return [
    { x: bx + (-dy * h) / d, y: by + (dx * h) / d },
    { x: bx - (-dy * h) / d, y: by - (dx * h) / d },
  ]
}

// 贴纸在同心圆图上的落点：法向轴之外两组圆的精确交点，按法向符号选分支。
function place(s: Sticker): Pt | null {
  const [x, y, z] = s.pos
  const [nx, ny, nz] = s.normal
  let pts: [Pt, Pt] | null
  let pick: (p: Pt) => number
  if (nx !== 0) {
    pts = circleIntersect(CENTERS[1], R(y), CENTERS[2], R(z))
    pick = nx > 0 ? (p) => p.x : (p) => -p.x
  } else if (ny !== 0) {
    pts = circleIntersect(CENTERS[0], R(x), CENTERS[2], R(z))
    pick = ny > 0 ? (p) => -p.y : (p) => p.y
  } else {
    pts = circleIntersect(CENTERS[0], R(x), CENTERS[1], R(y))
    pick = nz > 0 ? (p) => p.x : (p) => -p.x
  }
  if (!pts) return null
  return pick(pts[0]) > pick(pts[1]) ? pts[0] : pts[1]
}

// ---------------------------------------------------------------- cube model

export enum PGColors {
  White = "#ffffff",
  Orange = "#ff8000",
  Green = "#44ee00",
  Red = "#ff0000",
  Blue = "#2266ff",
  Yellow = "#f4f400"
}

const FACE_COLORS = [PGColors.White, PGColors.Orange, PGColors.Green, PGColors.Red, PGColors.Blue, PGColors.Yellow]
const FACE_NORMALS: readonly V3[] = [
  [0, 1, 0],
  [0, -1, 0],
  [1, 0, 0],
  [-1, 0, 0],
  [0, 0, 1],
  [0, 0, -1],
]

function initStickers(): Sticker[] {
  const out: Sticker[] = []
  let id = 0
  for (let f = 0; f < 6; f++) {
    const normal = FACE_NORMALS[f]
    const axes = [0, 1, 2].filter((i) => normal[i] === 0)
    for (const cu of [-1, 0, 1]) {
      for (const cv of [-1, 0, 1]) {
        const pos: V3 = [normal[0], normal[1], normal[2]]
        pos[axes[0]] += cu
        pos[axes[1]] += cv
        out.push({ id: id++, pos, normal, color: FACE_COLORS[f] })
      }
    }
  }
  return out
}

// 整数化旋转（90° 的倍数），避免浮点残差破坏层判断
function rotVec(v: V3, axis: Axis, deg: number): V3 {
  const t = (deg * Math.PI) / 180
  const c = Math.round(Math.cos(t))
  const s = Math.round(Math.sin(t))
  const [x, y, z] = v
  if (axis === 0) return [x, y * c - z * s, y * s + z * c]
  if (axis === 1) return [x * c + z * s, y, -x * s + z * c]
  return [x * c - y * s, x * s + y * c, z]
}



// 外层记号	对应中层记号	说明
// L / R	M	Middle 层，方向与 L 一致
// U / D	E	Equator 层，方向与 D 一致
// F / B	S	Standing 层，方向与 F 一致
// TODO: M, E, S 待实现
const FACE_MOVES: Record<string, { axis: Axis; layer: number; theta: number }> = {
  U: { axis: 1, layer: 1, theta: -90 },
  D: { axis: 1, layer: -1, theta: 90 },
  R: { axis: 0, layer: 1, theta: -90 },
  L: { axis: 0, layer: -1, theta: 90 },
  F: { axis: 2, layer: 1, theta: -90 },
  B: { axis: 2, layer: -1, theta: 90 },
}

const FACE_KEYS = Object.keys(FACE_MOVES)

// 每个同心圆组在屏幕坐标系中的正向，与 3D 右手坐标系的正向并不完全相同。
// 这个表把实际的层旋转角转换为屏幕上圆周 dot 应保持的统一方向。
const SCREEN_TURN_ORIENTATION: readonly [number, number, number] = [1, -1, -1]
const TAU = Math.PI * 2

function directedCircleAngle(theta0: number, theta1: number, direction: number): number {
  // atan2 在 -π/π 处断开。先取得最短的几何弧，再把它展开到本次转动的统一方向；
  // 这样同一圆周上的 dot 不会仅因跨越分支而反向。
  let delta = ((theta1 - theta0 + Math.PI) % TAU + TAU) % TAU - Math.PI
  if (Math.abs(delta) < 1e-9) return theta0
  if (delta * direction < 0) delta += direction * TAU
  return theta0 + delta
}

// ---------------------------------------------------------------- svg parts
// 同心圆与轴标：静态参考系，永远不旋转；只有 dots 动。
function CircleGroup({ axis }: { axis: Axis }) {
  const center = CENTERS[axis]
  return (
    <g>
      {RADII.map((r) => (
        <g key={r}>
          <circle
            cx={center.x}
            cy={center.y}
            r={r}
            fill='none'
            stroke='#3f3f46'
            strokeWidth={1.3}
          />
        </g>
      ))}
      <text x={center.x - 5} y={center.y + 5} fill='#ffffff' fontSize={18} fontWeight={600}>
        {AXIS_NAMES[axis]}
      </text>
    </g>
  )
}

// 沿所在圆周转动：把 dot 的 cx/cy 当作运动属性绑定到 motion.circle，
// 绕轴心用极坐标 (θ, r) 线性插值。motion 对 SVG 属性走 setAttribute，
// 完全绕开 CSS transform 管线（曾被其 transform-origin 强写 50% 50% 坑过）。
// 侧面 dots r0=r1 → 纯圆周；面内 dots 几何上必须螺旋，v=1 精确落点。
function StickerDot({
  s,
  progress,
  animRef,
}: {
  s: Sticker
  progress: MotionValue<number>
  animRef: RefObject<AnimState | null>
}) {
  const p = useMemo(() => place(s), [s])
  const cxMV = useTransform(progress, (v) => {
    const a = animRef.current
    const d = a?.deltas.get(s.id)
    if (!a || !d) return p?.x ?? 0
    const r = d.r0 + (d.r1 - d.r0) * v
    const t = d.theta0 + (d.theta1 - d.theta0) * v
    return a.center.x + r * Math.cos(t)
  })
  const cyMV = useTransform(progress, (v) => {
    const a = animRef.current
    const d = a?.deltas.get(s.id)
    if (!a || !d) return p?.y ?? 0
    const r = d.r0 + (d.r1 - d.r0) * v
    const t = d.theta0 + (d.theta1 - d.theta0) * v
    return a.center.y + r * Math.sin(t)
  })
  return (
    <motion.circle
      cx={cxMV}
      cy={cyMV}
      r={5.5}
      fill={s.color}
      stroke='rgba(0,0,0,0.4)'
      strokeWidth={1}
    />
  )
}

// ---------------------------------------------------------------- app
const TURN_MS = 420

export default function App() {
  const [stickers, setStickers] = useState<Sticker[]>(initStickers)
  const [anim, setAnim] = useState<AnimState | null>(null)
  const [history, setHistory] = useState<string[]>([])
  const stickersRef = useRef(stickers)
  const animRef = useRef<AnimState | null>(null)
  const busyRef = useRef(false)
  const queueRef = useRef<string[]>([])
  const genRef = useRef(0)
  const playerRef = useRef<HTMLElement | null>(null)
  const progress = useMotionValue(0)
  animRef.current = anim

  // 3D 播放器：等 custom element 升级完再写属性，避免属性被 own-property 影子覆盖。
  const playerReadyRef = useRef<Promise<unknown> | null>(null)
  const getPlayerReady = useCallback((): Promise<unknown> => {
    if (!playerReadyRef.current) {
      playerReadyRef.current = customElements.whenDefined('twisty-player')
    }
    return playerReadyRef.current as Promise<unknown>
  }, [])
  const syncPlayerMove = useCallback((face: string) => {
    void getPlayerReady().then(() => {
      const p = playerRef.current as any
      if (!p || typeof p.experimentalAddMove !== 'function') return
      try {
        p.experimentalAddMove(face)
      } catch {
        // ignore
      }
    })
  }, [getPlayerReady])
  const clearPlayerAlg = useCallback(() => {
    void getPlayerReady().then(() => {
      const p = playerRef.current as any
      if (!p) return
      try {
        p.alg = ''
      } catch {
        // ignore
      }
    })
  }, [getPlayerReady])

  const pump = useCallback(() => {
    if (busyRef.current || queueRef.current.length === 0) return
    const face = queueRef.current.shift()!
    const m = FACE_MOVES[face[0]]
    const turnTheta = face.endsWith("'") ? -m.theta : m.theta
    const screenDirection = Math.sign(turnTheta) * SCREEN_TURN_ORIENTATION[m.axis]
    busyRef.current = true
    const cur = stickersRef.current
    const next = cur.map((s) =>
      s.pos[m.axis] === m.layer
        ? {
            ...s,
            pos: rotVec(s.pos, m.axis, turnTheta),
            normal: rotVec(s.normal, m.axis, turnTheta),
          }
        : s,
    )
    const center = CENTERS[m.axis]
    const deltas = new Map<number, { theta0: number; r0: number; theta1: number; r1: number }>()
    for (let i = 0; i < cur.length; i++) {
      if (cur[i].pos[m.axis] !== m.layer) continue
      const p0 = place(cur[i])
      const p1 = place(next[i])
      if (!p0 || !p1) continue
      const dx0 = p0.x - center.x
      const dy0 = p0.y - center.y
      const dx1 = p1.x - center.x
      const dy1 = p1.y - center.y
      const r0 = Math.hypot(dx0, dy0)
      const r1 = Math.hypot(dx1, dy1)
      const theta0 = Math.atan2(dy0, dx0)
      const theta1 = Math.atan2(dy1, dx1)
      deltas.set(cur[i].id, {
        theta0,
        r0,
        // 半径不变才是同一个圆周上的 dot；螺旋运动保持其原本的几何落点插值。
        theta1: Math.abs(r0 - r1) < 1e-6 ? directedCircleAngle(theta0, theta1, screenDirection) : theta1,
        r1,
      })
    }
    const st: AnimState = {
      gen: ++genRef.current,
      axis: m.axis,
      center,
      deltas,
      next,
    }
    animRef.current = st
    setAnim(st)
    setHistory((h) => [...h.slice(-23), face])
    syncPlayerMove(face)
  }, [syncPlayerMove])

  const commit = useCallback(() => {
    const st = animRef.current
    if (!st || st.gen !== genRef.current) {
      busyRef.current = false
      return
    }
    stickersRef.current = st.next
    setStickers(st.next)
    animRef.current = null
    setAnim(null)
    busyRef.current = false
    pump()
  }, [pump])

  useEffect(() => {
    // 任意 anim 变化（含 →null 的 commit 落点）都重置 progress 一次，
    // 强迫 cx/cy motion value 用最新的 place(s) 重算，避免 commit 后残值。
    progress.set(0)
    if (!anim) return
    const controls = animate(progress, 1, {
      duration: TURN_MS / 1000,
      ease: [0.45, 0.05, 0.2, 1],
      onComplete: commit,
    })
    return () => controls.stop()
  }, [anim, commit, progress])

  const doMove = useCallback(
    (face: string) => {
      if (queueRef.current.length > 24) return
      queueRef.current.push(face)
      pump()
    },
    [pump],
  )

  const scramble = useCallback(() => {
    for (let i = 0; i < 20; i++) {
      const f = FACE_KEYS[Math.floor(Math.random() * FACE_KEYS.length)]
      queueRef.current.push(Math.random() < 0.5 ? f : `${f}'`)
    }
    pump()
  }, [pump])

  const reset = useCallback(() => {
    queueRef.current = []
    genRef.current++
    const fresh = initStickers()
    stickersRef.current = fresh
    setStickers(fresh)
    animRef.current = null
    setAnim(null)
    busyRef.current = false
    setHistory([])
    clearPlayerAlg()
  }, [clearPlayerAlg])

  // 键盘操作：U/D/L/R/F/B，Shift 为逆时针
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const k = e.key.toUpperCase()
      if (k in FACE_MOVES) doMove(e.shiftKey ? `${k}'` : k)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [doMove])

  // 3D 播放器配置
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
  }, [getPlayerReady])

  const dots = stickers.map((s) => (
    <StickerDot key={s.id} s={s} progress={progress} animRef={animRef} />
  ))

  return (
    <div className='flex h-screen flex-col bg-zinc-950 text-zinc-100'>
      <header className='flex items-baseline justify-between border-zinc-800 border-b px-6 py-3'>
        <h1 className='font-semibold text-lg tracking-tight'>魔方 · 同心圆可视化</h1>
        <p className='text-xs text-zinc-500'>
          左：立体魔方（cubing twisty-player） · 右：同心圆投影，转动实时同步
        </p>
      </header>

      <main className='flex min-h-0 flex-1 gap-4 p-4'>
        <section className='flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900'>
          <div className='min-h-0 flex-1'>
            <twisty-player
              alg="R U R' U' R' F R2 U' R' U' R U R' F'"
              ref={playerRef}
              // 不要加 block：cubing 依赖宿主元素的 display:grid 让 shadow root 的根节点撑满高度。
              className='h-full w-full'
              style={{ width: '100%', height: '100%', minHeight: 128 }}
            />
          </div>
          <div className='border-zinc-800 border-t p-3'>
            <div className='mb-2 h-4 truncate font-mono text-xs text-zinc-400'>
              {history.join(' ')}
            </div>
            <div>
            <div className='flex flex-wrap items-center gap-1.5'>
              {FACE_KEYS.map((f) => (
                <Button
                  key={f}
                  variant='outline'
                  size='sm'
                  className='w-11 font-mono text-blue-500'
                  onClick={() => doMove(f)}
                >
                  {f}
                </Button>
              ))}
              </div>
              <div className='flex flex-wrap items-center gap-1.5'>
              {FACE_KEYS.map((f) => (
                <Button
                  key={`${f}'`}
                  variant='ghost'
                  size='sm'
                  className='w-11 font-mono'
                  onClick={() => doMove(`${f}'`)}
                >
                  {f}&prime;
                </Button>
              ))}
              </div>
              
              <Button variant='secondary' size='sm' onClick={scramble}>
                打乱
              </Button>
              <Button variant='secondary' size='sm' onClick={reset}>
                复位
              </Button>
            </div>
            <p className='mt-2 text-xs text-zinc-600'>
              键盘 U / D / L / R / F / B 转动对应面，按住 Shift 为逆时针（&prime;）
            </p>
          </div>
        </section>

        <section className='flex min-w-0 flex-1 items-center justify-center rounded-xl border border-zinc-800 bg-zinc-900 p-2'>
          <svg
            viewBox='0 0 500 460'
            role='img'
            aria-label='魔方同心圆投影图'
            className='h-full w-full'
          >
            {([0, 1, 2] as Axis[]).map((a) => (
              <CircleGroup key={a} axis={a} />
            ))}
            {dots}
          </svg>
        </section>
      </main>
    </div>
  )
}
