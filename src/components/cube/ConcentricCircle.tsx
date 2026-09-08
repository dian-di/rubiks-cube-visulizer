// 魔方同心圆投影图：静态参考系（三轴同心圆 + 轴标）永远不旋转，只有 dots 动。
// 本组件持有全局唯一的 progress MotionValue，并负责驱动一次转动的逐帧动画；
// dots 的位置全部是 progress 的 transform，React 不参与逐帧渲染。

import { useEffect, useMemo } from 'react'
import { animate, motion, useMotionValue, useTransform } from 'motion/react'
import type { MotionValue } from 'motion/react'
import { useCubeStore } from '@/store/cubeStore'
import {
  CENTERS,
  RADII,
  R,
  AXIS_NAMES,
  place,
  type Sticker,
  type Axis,
} from '@/lib/cube'

const TURN_MS = 420

// 同心圆与轴标：静态参考系，永远不旋转；只有 dots 动。
function CircleGroup({ axis, highlight }: { axis: Axis; highlight: { axis: Axis; layer: number } | null }) {
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
//   1. 无动画（store.anim 为空）→ 静态落点 place(s)；
//   2. delta 为 line  → 屏幕坐标直线插值（面内 dot，跨圆组迁移）；
//   3. delta 为 arc   → 绕圆心极坐标 (θ, r) 插值（侧面 dot，纯圆周运动，
//                       r0≈r1，θ 已方向归一见 ArcDelta）。
//
// 实现细节：
//   - cx/cy 不是 state 而是 useTransform(progress)：progress 每帧变化时
//     motion 自动重算并 setAttribute，React 不参与逐帧渲染。
//   - useTransform 闭包里读 store.getState().anim（非响应式读），拿到的
//     永远是当前代动画的 deltas；动画切换由外层重置 progress 触发重算。
//   - motion 对 SVG 属性走 setAttribute，完全绕开 CSS transform 管线
//     （曾被其 transform-origin 强写 50% 50% 坑过）。
function StickerDot({ s, progress }: { s: Sticker; progress: MotionValue<number> }) {
  // 静态落点：仅在无动画时使用（动画期间由 delta 接管坐标）。
  const p = useMemo(() => place(s), [s])
  const cxMV = useTransform(progress, (v) => {
    const a = useCubeStore.getState().anim
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
    const a = useCubeStore.getState().anim
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

export function ConcentricCircle() {
  const stickers = useCubeStore((s) => s.stickers)
  const anim = useCubeStore((s) => s.anim)
  const highlight = useCubeStore((s) => s.highlight)
  const commit = useCubeStore((s) => s.commit)
  // 全局动画进度 0→1：唯一的逐帧驱动源，所有 dot 位置都是它的 transform。
  const progress = useMotionValue(0)

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

  const dots = stickers.map((s) => <StickerDot key={s.id} s={s} progress={progress} />)

  return (
    <svg viewBox='0 0 500 460' role='img' aria-label='魔方同心圆投影图' className='h-full w-full'>
      {([0, 1, 2] as Axis[]).map((a) => (
        <CircleGroup key={a} axis={a} highlight={highlight} />
      ))}
      {dots}
    </svg>
  )
}
