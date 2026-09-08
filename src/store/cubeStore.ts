// 魔方全局 store：持有贴纸逻辑状态 + 动画状态，并暴露引擎动作
// （pump / commit / doMove / scramble / reset）。多组件通过本 store 共享消息，
// 不再层层透传 props。逐帧同步所需的引用（stickersRef / busyRef / queueRef /
// genRef / animRef）以模块级变量持有——store 是单例，生命周期与 App 一致。

import { create } from 'zustand'
import {
  initStickers,
  rotVec,
  FACE_MOVES,
  FACE_KEYS,
  SCREEN_TURN_ORIENTATION,
  directedCircleAngle,
  CENTERS,
  RADII,
  place,
  type Sticker,
  type Axis,
  type AnimState,
  type ArcDelta,
  type LineDelta,
} from '@/lib/cube'

export interface CubeState {
  // ---- 响应式状态（驱动渲染） ----
  stickers: Sticker[]
  anim: AnimState | null
  history: string[]
  highlight: { axis: Axis; layer: number } | null
  // ---- 3D 播放器事件（计数式，避免连续同手被 React 合并） ----
  // 每次转动递增 moveToken；TwistyPlayerView 据此播放 lastMove。
  lastMove: string
  moveToken: number
  // reset 时递增 playerClearToken，让播放器清空 alg。
  playerClearToken: number
  // ---- 引擎动作 ----
  pump: () => void
  commit: () => void
  doMove: (face: string) => void
  scramble: () => void
  reset: () => void
}

// ---------------------------------------------------------------- 引擎引用
// 非响应式可变引用：逐帧 / 跨回调同步读取，避免 re-render 抖动。
let stickersRef: Sticker[] = initStickers()
let busyRef = false
let queueRef: string[] = []
let genRef = 0
let animRef: AnimState | null = null

// ---------------------------------------------------------------- store
export const useCubeStore = create<CubeState>((set, get) => ({
  stickers: initStickers(),
  anim: null,
  history: [],
  highlight: null,
  lastMove: '',
  moveToken: 0,
  playerClearToken: 0,

  // 消费转动队列：同一时刻只允许一个动画在跑（busyRef 门闩），
  // 其余请求留在 queueRef 里由 commit → pump 链式接力。
  pump: () => {
    if (busyRef) return
    // 队列已空且无动画在跑 → 无「当前圆周」，消除高亮。
    if (queueRef.length === 0) {
      set({ highlight: null })
      return
    }
    const face = queueRef.shift()!
    const m = FACE_MOVES[face[0]]
    // 撇号（prime）= 逆时针，取反该面的基准转角。
    const turnTheta = face.endsWith("'") ? -m.theta : m.theta
    // 层旋转角 → 屏幕圆周方向的映射：SCREEN_TURN_ORIENTATION 见其定义处注释。
    const screenDirection = Math.sign(turnTheta) * SCREEN_TURN_ORIENTATION[m.axis]
    busyRef = true
    // 点亮本次转动所在的圆周：该面所在轴组里、对应层半径的那条圆。
    set({ highlight: { axis: m.axis, layer: m.layer } })
    const cur = stickersRef
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
        // 保证整层所有 dot 绕行方向一致、不跨 ±π 分支。
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
      gen: ++genRef,
      axis: m.axis,
      center,
      deltas,
      next,
    }
    animRef = st
    set((s) => ({
      anim: st,
      history: [...s.history.slice(-23), face],
      lastMove: face,
      moveToken: s.moveToken + 1,
    }))
  },

  // 动画完成：把预计算的 next 原子提交为当前状态，然后接力队列里的下一手。
  commit: () => {
    const st = animRef
    // gen 不匹配 = 这份动画已被 reset 作废（或被新动画取代），丢弃即可。
    if (!st || st.gen !== genRef) {
      busyRef = false
      return
    }
    stickersRef = st.next
    animRef = null
    busyRef = false
    set({ stickers: st.next, anim: null })
    get().pump()
  },

  // 转动入口：入队（上限 24 手防连按堆积）后尝试立即开跑。
  doMove: (face) => {
    if (queueRef.length > 24) return
    queueRef.push(face)
    get().pump()
  },

  // 打乱：随机 20 手入队，pump 链会依次串行执行。
  scramble: () => {
    for (let i = 0; i < 20; i++) {
      const f = FACE_KEYS[Math.floor(Math.random() * FACE_KEYS.length)]
      queueRef.push(Math.random() < 0.5 ? f : `${f}'`)
    }
    get().pump()
  },

  // 复位：清队列 + bump 代际（作废在途动画的 commit）+ 回到初始状态。
  reset: () => {
    queueRef = []
    genRef++
    const fresh = initStickers()
    stickersRef = fresh
    animRef = null
    busyRef = false
    set((s) => ({
      stickers: fresh,
      anim: null,
      highlight: null,
      history: [],
      playerClearToken: s.playerClearToken + 1,
    }))
  },
}))
