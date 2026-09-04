import type { MotionValue } from 'motion/react'
import { animate, motion, useMotionValue, useTransform } from 'motion/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import 'cubing/twisty'
import type { RefObject } from 'react'
import { Button } from '@/components/ui/button'

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

// ---------------------------------------------------------------- types
// V3 / Pt / Sticker 描述 3D 魔方的逻辑状态：每个贴纸有整数格点坐标 pos
// （各分量 ∈ {-1, 0, 1}）和面法向 normal。渲染与动画只消费 2D 投影 place(s)。

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

// ---- 两种插值路径（一次转动中每个受影响 dot 二选一） ----

// 圆周弧插值：dot 起止点都落在该轴某条画出的同心圆上（r0≈r1≈RADII 之一），
// 绕圆心做极坐标 (θ, r) 线性插值。r0≈r1 → 纯圆周运动。
// theta1 已经过 directedCircleAngle 方向归一：同一层内所有 dot 绕行方向一致，
// 且不会因 atan2 ±π 分支断裂而反向绕整圈。
interface ArcDelta {
  kind: 'arc'
  theta0: number
  r0: number
  theta1: number
  r1: number
}

// 直线插值：起止点不在同一画出的圆周上（典型为转动面的面内 dot，其投影
// 从一条同心圆跳到另一条），极坐标插值会产生穿过图心的长螺旋——
// 跨 ±π 分支时长达 226°~329°。所以直接在屏幕坐标系里直线平移到目标落点。
interface LineDelta {
  kind: 'line'
  x0: number
  y0: number
  x1: number
  y1: number
}

// 一次转动的完整动画状态。
interface AnimState {
  // 代际计数：每开新动画 / reset 时自增。commit 前校验 gen === genRef.current，
  // 防止已被 reset 作废的动画在 onComplete 回调里把旧状态提交回去。
  gen: number
  // 本次转动的旋转轴（0/1/2 = X/Y/Z），决定绕哪个圆组转。
  axis: Axis
  // 该轴圆组在屏幕上的圆心（极坐标插值的原点）。
  center: Pt
  // 受影响 dot 的插值参数，key = sticker id。
  deltas: Map<number, ArcDelta | LineDelta>
  // 转动结束后的贴纸逻辑状态，动画完成时由 commit 原子提交。
  next: Sticker[]
}

// ---------------------------------------------------------------- geometry
// 同心圆投影的核心思想：
//   贴纸的法向轴决定它「不属于」哪一组圆；其余两个坐标分量各决定它落在
//   对应圆组的哪一条同心圆上。因此贴纸的 2D 落点 = 这两条圆的交点
//   （见 place()）。转动某层时，该层贴纸沿所属轴圆组移动——侧面贴纸
//   停留在同一条圆周上（arc），转动面内的贴纸则在圆组之间迁移（line）。
//
// 同心圆布局：Y 组在上方，X 组在右下、Z 组在左下。三个半径对应层坐标 -1/0/+1。
// 注意：X/Z 与下排左右组的对应关系决定 Y 圆周上四个色簇的相位（蓝红绿橙，顺时针）。
const CENTERS: readonly [Pt, Pt, Pt] = [
  { x: 335, y: 290 }, // X
  { x: 250, y: 170 }, // Y
  { x: 165, y: 290 }, // Z
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
    // X 组在右下后，+Z（绿）取靠左下的交点、−Z（蓝）取靠右上的交点，
    // 使 Y 圆周顺时针色序为 蓝红绿橙（各面较此前前进一位）。
    pick = nz > 0 ? (p) => -p.x : (p) => p.x
  }
  if (!pts) return null
  return pick(pts[0]) > pick(pts[1]) ? pts[0] : pts[1]
}

// ---------------------------------------------------------------- cube model

export enum PGColors {
  White = '#ffffff',
  Orange = '#ff8000',
  Green = '#44ee00',
  Red = '#ff0000',
  Blue = '#2266ff',
  Yellow = '#f4f400',
}

const FACE_COLORS = [
  PGColors.White, // U / +Y
  PGColors.Yellow, // D / -Y
  PGColors.Red, // R / +X
  PGColors.Orange, // L / -X
  PGColors.Green, // F / +Z
  PGColors.Blue, // B / -Z
]
const FACE_NORMALS: readonly V3[] = [
  [0, 1, 0], // U
  [0, -1, 0], // D
  [1, 0, 0], // R
  [-1, 0, 0], // L
  [0, 0, 1], // F
  [0, 0, -1], // B
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
// U / D	E	Equator 层，方向与 D 一致
// L / R	M	Middle 层，方向与 L 一致
// F / B	S	Standing 层，方向与 F 一致
const FACE_MOVES: Record<string, { axis: Axis; layer: number; theta: number }> = {
  U: { axis: 1, layer: 1, theta: -90 },
  D: { axis: 1, layer: -1, theta: 90 },
  L: { axis: 0, layer: -1, theta: 90 },
  R: { axis: 0, layer: 1, theta: -90 },
  F: { axis: 2, layer: 1, theta: -90 },
  B: { axis: 2, layer: -1, theta: 90 },
  // 中层：M 同 L 方向（x=0），E 同 D 方向（y=0），S 同 F 方向（z=0）
  E: { axis: 1, layer: 0, theta: 90 },
  M: { axis: 0, layer: 0, theta: 90 },
  S: { axis: 2, layer: 0, theta: -90 },
}

const FACE_KEYS = Object.keys(FACE_MOVES)

// 每个同心圆组在屏幕坐标系中的正向，与 3D 右手坐标系的正向并不相同。
// 这个表把实际的层旋转角转换为屏幕上圆周 dot 应保持的统一方向。
// 实测（每个转动 12~13 个圆周 dot 的自然短弧方向多数派）：
// U/F/R 顺时针、D/L/B 逆时针 → 三个轴均为 -1。
const SCREEN_TURN_ORIENTATION: readonly [number, number, number] = [-1, -1, -1]
const TAU = Math.PI * 2

function directedCircleAngle(theta0: number, theta1: number, direction: number): number {
  // atan2 在 -π/π 处断开，两个几乎相邻的角度可能差出 ~2π。
  // 三步归一：
  //   1. 把角差折叠到 (-π, π]（最短几何弧）；
  //   2. 若最短弧方向与本次转动的统一方向（direction，+1/-1）相反，
  //      加减一整圈 2π 展开到正确方向；
  //   3. 角差为 0 时保持原角度，避免方向修正引入 ±TAU 的假转动。
  // 这样同一圆周上的 dot 不会仅因跨越 ±π 分支而反向，也不会绕远圈。
  let delta = ((((theta1 - theta0 + Math.PI) % TAU) + TAU) % TAU) - Math.PI
  if (Math.abs(delta) < 1e-9) return theta0
  if (delta * direction < 0) delta += direction * TAU
  return theta0 + delta
}

// ---------------------------------------------------------------- svg parts
// 同心圆与轴标：静态参考系，永远不旋转；只有 dots 动。
function CircleGroup({
  axis,
  highlight,
}: {
  axis: Axis
  highlight: { axis: Axis; layer: number } | null
}) {
  const center = CENTERS[axis]
  // 本次高亮命中的半径：仅当高亮落在当前轴组、且半径等于该层半径时才点亮。
  const hlRadius = highlight && highlight.axis === axis ? R(highlight.layer) : null
  return (
    <g>
      {RADII.map((r) => {
        const active = hlRadius === r
        return (
          <g key={r}>
            <circle
              cx={center.x}
              cy={center.y}
              r={r}
              fill='none'
              stroke={active ? '#f4f400' : '#3f3f46'}
              strokeWidth={active ? 4 : 2}
            />
          </g>
        )
      })}
      <text x={center.x - 5} y={center.y + 5} fill='#ffffff' fontSize={18} fontWeight={600}>
        {AXIS_NAMES[axis]}
      </text>
    </g>
  )
}

// 单个贴纸 dot 的渲染与逐帧位置计算。
//
// 位置来源按优先级：
//   1. 无动画（animRef.current 为空）→ 静态落点 place(s)；
//   2. delta 为 line  → 屏幕坐标直线插值（面内 dot，跨圆组迁移）；
//   3. delta 为 arc   → 绕圆心极坐标 (θ, r) 插值（侧面 dot，纯圆周运动，
//                       r0≈r1，θ 已方向归一见 ArcDelta）。
//
// 实现细节：
//   - cx/cy 不是 state 而是 useTransform(progress)：progress 每帧变化时
//     motion 自动重算并 setAttribute，React 不参与逐帧渲染。
//   - useTransform 闭包里读 animRef.current（ref 而非 state），拿到的
//     永远是当前代动画的 deltas；动画切换由外层重置 progress 触发重算。
//   - motion 对 SVG 属性走 setAttribute，完全绕开 CSS transform 管线
//     （曾被其 transform-origin 强写 50% 50% 坑过）。
function StickerDot({
  s,
  progress,
  animRef,
}: {
  s: Sticker
  progress: MotionValue<number>
  animRef: RefObject<AnimState | null>
}) {
  // 静态落点：仅在无动画时使用（动画期间由 delta 接管坐标）。
  const p = useMemo(() => place(s), [s])
  const cxMV = useTransform(progress, (v) => {
    const a = animRef.current
    const d = a?.deltas.get(s.id)
    if (!a || !d) return p?.x ?? 0
    // 直线分支：直接在笛卡尔坐标上线性插值。
    if (d.kind === 'line') return d.x0 + (d.x1 - d.x0) * v
    // 圆弧分支：r、θ 各自线性插值（θ 已归一，差值即真实扫过角度）。
    const r = d.r0 + (d.r1 - d.r0) * v
    const t = d.theta0 + (d.theta1 - d.theta0) * v
    return a.center.x + r * Math.cos(t)
  })
  const cyMV = useTransform(progress, (v) => {
    const a = animRef.current
    const d = a?.deltas.get(s.id)
    if (!a || !d) return p?.y ?? 0
    if (d.kind === 'line') return d.y0 + (d.y1 - d.y0) * v
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
  // ---- 运行时状态：React state（触发渲染）+ ref（逐帧/跨回调同步读）双轨 ----
  const [stickers, setStickers] = useState<Sticker[]>(initStickers)
  const [anim, setAnim] = useState<AnimState | null>(null)
  const [history, setHistory] = useState<string[]>([])
  // 当前正在转动的圆周高亮（轴组 + 层）。pump 开转时点亮、队列清空/复位时消除。
  const [highlight, setHighlight] = useState<{ axis: Axis; layer: number } | null>(null)
  // 贴纸逻辑状态的即时镜像：pump/commit 里同步读，不等 re-render。
  const stickersRef = useRef(stickers)
  // 当前动画的即时镜像：useTransform 逐帧读 deltas。
  const animRef = useRef<AnimState | null>(null)
  // 动画门闩：true = 有动画在跑，pump 据此串行化队列。
  const busyRef = useRef(false)
  // 待执行转动队列（doMove 入队、pump 出队）。
  const queueRef = useRef<string[]>([])
  // 动画代际计数：pump 自增、reset 自增，commit 用它作废在途的旧回调。
  const genRef = useRef(0)
  const playerRef = useRef<HTMLElement | null>(null)
  // 全局动画进度 0→1：唯一的逐帧驱动源，所有 dot 位置都是它的 transform。
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
  const syncPlayerMove = useCallback(
    (face: string) => {
      void getPlayerReady().then(() => {
        const p = playerRef.current as any
        if (!p || typeof p.experimentalAddMove !== 'function') return
        try {
          p.experimentalAddMove(face)
        } catch {
          // ignore
        }
      })
    },
    [getPlayerReady],
  )
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

  // 消费转动队列：同一时刻只允许一个动画在跑（busyRef 门闩），
  // 其余请求留在 queueRef 里由 commit → pump 链式接力。
  const pump = useCallback(() => {
    if (busyRef.current) return
    // 队列已空且无动画在跑 → 无「当前圆周」，消除高亮。
    if (queueRef.current.length === 0) {
      setHighlight(null)
      return
    }
    const face = queueRef.current.shift()!
    const m = FACE_MOVES[face[0]]
    // 撇号（prime）= 逆时针，取反该面的基准转角。
    const turnTheta = face.endsWith("'") ? -m.theta : m.theta
    // 层旋转角 → 屏幕圆周方向的映射：SCREEN_TURN_ORIENTATION 见其定义处注释。
    const screenDirection = Math.sign(turnTheta) * SCREEN_TURN_ORIENTATION[m.axis]
    busyRef.current = true
    // 点亮本次转动所在的圆周：该面所在轴组里、对应层半径的那条圆。
    setHighlight({ axis: m.axis, layer: m.layer })
    const cur = stickersRef.current
    // 预计算转动后的贴纸状态（动画期间仅作为 delta 的终点，commit 时才提交）。
    // 层判断用严格整数比较（pos[axis] === layer），rotVec 的整数化保证无浮点残差。
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
    const deltas = new Map<number, ArcDelta | LineDelta>()
    // 只有起止都在画出的同心圆（r∈RADII）上的 dot 才做圆周运动；
    // 面内 dot（含 r0 数值上等于 r1 但不在任何画出的圆上的情况）直接平移。
    // 双重条件缺一不可：仅判 r0≈r1 会把「碰巧等半径的跨圆组迁移」误判为圆周。
    const onDrawnCircle = (r: number) => RADII.some((rad) => Math.abs(r - rad) < 0.5)
    for (let i = 0; i < cur.length; i++) {
      // 只处理该层的贴纸；其他层的落点在动画期间不变（走静态 place 分支）。
      if (cur[i].pos[m.axis] !== m.layer) continue
      const p0 = place(cur[i])
      const p1 = place(next[i])
      if (!p0 || !p1) continue
      const r0 = Math.hypot(p0.x - center.x, p0.y - center.y)
      const r1 = Math.hypot(p1.x - center.x, p1.y - center.y)
      if (Math.abs(r0 - r1) < 1e-6 && onDrawnCircle(r0)) {
        // 侧面 dot：起止同圆 → 圆周弧。theta1 做方向归一，
        // 保证整层 12 个 dot 绕行方向一致、不跨 ±π 分支。
        const theta0 = Math.atan2(p0.y - center.y, p0.x - center.x)
        const theta1 = Math.atan2(p1.y - center.y, p1.x - center.x)
        deltas.set(cur[i].id, {
          kind: 'arc',
          theta0,
          r0,
          theta1: directedCircleAngle(theta0, theta1, screenDirection),
          r1,
        })
      } else {
        // 面内 dot：起止不同圆（或不在画出的圆上）→ 直线直达目标落点。
        deltas.set(cur[i].id, {
          kind: 'line',
          x0: p0.x,
          y0: p0.y,
          x1: p1.x,
          y1: p1.y,
        })
      }
    }
    const st: AnimState = {
      // 新代际：作废任何仍在途的旧动画回调（见 commit 的 gen 校验）。
      gen: ++genRef.current,
      axis: m.axis,
      center,
      deltas,
      next,
    }
    // ref 与 state 双写：ref 供 useTransform 逐帧读取（同步、无重渲染），
    // state 触发下方 useEffect 启动 progress 动画。
    animRef.current = st
    setAnim(st)
    setHistory((h) => [...h.slice(-23), face])
    // 3D 播放器同步播放同一手（异步，不阻塞 2D 动画）。
    syncPlayerMove(face)
  }, [syncPlayerMove, setHighlight])

  // 动画完成：把预计算的 next 原子提交为当前状态，然后接力队列里的下一手。
  const commit = useCallback(() => {
    const st = animRef.current
    // gen 不匹配 = 这份动画已被 reset 作废（或被新动画取代），丢弃即可。
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
    // progress 0→1 驱动所有 delta 插值；onComplete 走 commit 而非 setState 落点，
    // 保证「动画帧」与「状态提交」严格串行。卸载/换代时 stop() 中断旧动画。
    const controls = animate(progress, 1, {
      duration: TURN_MS / 1000,
      ease: [0.45, 0.05, 0.2, 1],
      onComplete: commit,
    })
    return () => controls.stop()
  }, [anim, commit, progress])

  // 转动入口：入队（上限 24 手防连按堆积）后尝试立即开跑。
  const doMove = useCallback(
    (face: string) => {
      if (queueRef.current.length > 24) return
      queueRef.current.push(face)
      pump()
    },
    [pump],
  )

  // 打乱：随机 20 手入队，pump 链会依次串行执行。
  const scramble = useCallback(() => {
    for (let i = 0; i < 20; i++) {
      const f = FACE_KEYS[Math.floor(Math.random() * FACE_KEYS.length)]
      queueRef.current.push(Math.random() < 0.5 ? f : `${f}'`)
    }
    pump()
  }, [pump])

  // 复位：清队列 + bump 代际（作废在途动画的 commit）+ 回到初始状态。
  const reset = useCallback(() => {
    queueRef.current = []
    genRef.current++
    setHighlight(null)
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
              alg=''
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
              键盘 U / D / L / R / F / B / M / E / S 转动对应层，按住 Shift 为逆时针（&prime;）
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
              <CircleGroup key={a} axis={a} highlight={highlight} />
            ))}
            {dots}
          </svg>
        </section>
      </main>
    </div>
  )
}
