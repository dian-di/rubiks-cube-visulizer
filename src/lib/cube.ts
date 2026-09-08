// 魔方逻辑模型与同心圆投影几何（纯逻辑，无 React 依赖）。
//
// V3 / Pt / Sticker 描述 3D 魔方的逻辑状态：每个贴纸有整数格点坐标 pos
// （各分量 ∈ 当前阶的层坐标集合）和面法向 normal。渲染与动画只消费 2D 投影 place(s)。
//
// 阶数（order）：支持 2 / 3 / 4 阶，UI 提供切换。每阶的层坐标 levels 与对应
// 同心圆半径 radii 一一对应，因此 place() 与转动动画可完全复用——只需把 geom 透传下去。
// 4 阶除「外层」转动（U/D/L/R/F/B，单外层）外，额外提供「宽两层」转动
// （u/d/l/r/f/b，外层 + 相邻内层一起转），用于还原 4 阶常见手顺。

// 支持的阶数。2 / 3 / 4 均已实现并接入切换。
export type CubeOrder = 2 | 3 | 4

export type V3 = [number, number, number]
export type Axis = 0 | 1 | 2

export interface Pt {
  x: number
  y: number
}

export interface Sticker {
  id: number
  pos: V3
  normal: V3
  color: string
}

// 每阶的几何与转动配置。levels / radii 长度等于阶数，index 互相对应：
// levels[i] 是第 i 层沿轴的坐标值，radii[i] 是它在同心圆投影里对应的半径。
export interface OrderGeom {
  order: CubeOrder
  // 每层沿轴向的坐标值（对称分布）。n=2 → {-1,1}；n=3 → {-1,0,1}；n=4 → {-1,-1/3,1/3,1}
  levels: number[]
  // 每个 level 对应的同心圆半径（与 levels 同序）
  radii: number[]
  // 该阶支持的转动记号：
  //   - 外层 U/D/L/R/F/B（各阶通用，单外层，layers=[±1]）；
  //   - 3 阶额外含中层 M/E/S（layers=[0]）；
  //   - 4 阶额外含宽两层 u/d/l/r/f/b（外层 + 相邻内层，layers 含两个层坐标）。
  // theta 为该组层的旋转角（90° 倍数），顺时针为正向约定。
  faceMoves: Record<string, { axis: Axis; layers: number[]; theta: number }>
}

// ---- 两种插值路径（一次转动中每个受影响 dot 二选一） ----

// 圆周弧插值：dot 起止点都落在该轴某条画出的同心圆上（r0≈r1≈radii 之一），
// 绕圆心做极坐标 (θ, r) 线性插值。r0≈r1 → 纯圆周运动。
// theta1 已经过 directedCircleAngle 方向归一：同一层内所有 dot 绕行方向一致，
// 且不会因 atan2 ±π 分支断裂而反向绕整圈。
export interface ArcDelta {
  kind: 'arc'
  theta0: number
  r0: number
  theta1: number
  r1: number
}

// 直线插值：起止点不在同一画出的圆周上（典型为转动面的面内 dot，其投影
// 从一条同心圆跳到另一条），极坐标插值会产生穿过图心的长螺旋——
// 跨 ±π 分支时长达 226°~329°。所以直接在屏幕坐标系里直线平移到目标落点。
export interface LineDelta {
  kind: 'line'
  x0: number
  y0: number
  x1: number
  y1: number
}

// 一次转动的完整动画状态。
export interface AnimState {
  // 代际计数：每开新动画 / reset 时自增。commit 前校验 gen === genRef，
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
export const CENTERS: readonly [Pt, Pt, Pt] = [
  { x: 335, y: 290 }, // X
  { x: 250, y: 170 }, // Y
  { x: 165, y: 290 }, // Z
]
export const AXIS_NAMES = ['X', 'Y', 'Z']

const TAU = Math.PI * 2

// 各阶共享的外层转动记号（U/D/L/R/F/B）：单外层，层坐标恒为 ±1。
// U / D 沿 Y；L / R 沿 X；F / B 沿 Z；转动角与 3 阶一致。
const OUTER_FACE_MOVES: Record<string, { axis: Axis; layers: number[]; theta: number }> = {
  U: { axis: 1, layers: [1], theta: -90 },
  D: { axis: 1, layers: [-1], theta: 90 },
  L: { axis: 0, layers: [-1], theta: 90 },
  R: { axis: 0, layers: [1], theta: -90 },
  F: { axis: 2, layers: [1], theta: -90 },
  B: { axis: 2, layers: [-1], theta: 90 },
}

// 3 阶额外的中层记号：M 同 L 方向（x=0），E 同 D 方向（y=0），S 同 F 方向（z=0）。
const MIDDLE_FACE_MOVES: Record<string, { axis: Axis; layers: number[]; theta: number }> = {
  E: { axis: 1, layers: [0], theta: 90 },
  M: { axis: 0, layers: [0], theta: 90 },
  S: { axis: 2, layers: [0], theta: -90 },
}

// 4 阶额外的「宽两层」记号：外层 + 相邻内层一起转（WCA 大阶记法小写 = wide）。
// 方向与对应外层一致，layers 含外层坐标与相邻内层坐标（±1/3）。
const WIDE_FACE_MOVES: Record<string, { axis: Axis; layers: number[]; theta: number }> = {
  u: { axis: 1, layers: [1, 1 / 3], theta: -90 },
  d: { axis: 1, layers: [-1, -1 / 3], theta: 90 },
  l: { axis: 0, layers: [-1, -1 / 3], theta: 90 },
  r: { axis: 0, layers: [1, 1 / 3], theta: -90 },
  f: { axis: 2, layers: [1, 1 / 3], theta: -90 },
  b: { axis: 2, layers: [-1, -1 / 3], theta: 90 },
}

// 每阶几何配置（单一数据源）。UI 仅暴露 SUPPORTED_ORDERS 中的阶。
export const ORDER_GEOMS: Record<CubeOrder, OrderGeom> = {
  2: {
    order: 2,
    // 2 阶（二阶/Pocket Cube）：每层只有 ±1 两层，无中层 → 仅外层转动。
    levels: [-1, 1],
    radii: [100, 148],
    faceMoves: OUTER_FACE_MOVES,
  },
  3: {
    order: 3,
    // 3 阶（标准魔方）：三层 -1/0/+1，含中层 M/E/S。
    levels: [-1, 0, 1],
    radii: [100, 124, 148],
    faceMoves: { ...OUTER_FACE_MOVES, ...MIDDLE_FACE_MOVES },
  },
  4: {
    // 4 阶：支持。外层（U/D/L/R/F/B）单转最外层，宽两层（u/d/l/r/f/b）转最外层 + 相邻内层。
    // 层坐标归一化到 [-1, 1]（与面法向 ±1 对齐）：±1 为最外层，±1/3 为相邻内层。
    // radii 取 4 档：经几何优化，使同一对称轴上「外圈∩内圈」的两类贴纸不再因镜像靠得太近
    // （最小贴纸间距由旧值 3px 提升到 ~18px，消除正中心重叠）。内圈偏大(102)把中心贴纸向外推、
    // 同时保证任意两圆组（X/Z 圆心距 170）仍可相交（需 2·rMin ≥ 170 ⇒ rMin ≥ 85）。
    order: 4,
    levels: [-1, -1 / 3, 1 / 3, 1],
    radii: [102, 120, 139, 157],
    faceMoves: { ...OUTER_FACE_MOVES, ...WIDE_FACE_MOVES },
  },
}

// UI 实际可切换的阶数。新增支持时把对应阶加入此数组即可。
export const SUPPORTED_ORDERS: CubeOrder[] = [2, 3, 4]

// 当前阶的转动记号列表（键盘 / 按钮 / 打乱共用）。
export function faceKeysFor(order: CubeOrder): string[] {
  return Object.keys(ORDER_GEOMS[order].faceMoves)
}

// 层坐标 → 同心圆半径（按 geom.levels 的 index 取 geom.radii）。
export function radiusForLevel(geom: OrderGeom, level: number): number {
  const idx = geom.levels.indexOf(level)
  return geom.radii[idx < 0 ? 0 : idx]
}

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
// geom 决定层坐标到半径的映射（阶相关）。
export function place(s: Sticker, geom: OrderGeom): Pt | null {
  const [x, y, z] = s.pos
  const [nx, ny, nz] = s.normal
  let pts: [Pt, Pt] | null
  let pick: (p: Pt) => number
  if (nx !== 0) {
    pts = circleIntersect(CENTERS[1], radiusForLevel(geom, y), CENTERS[2], radiusForLevel(geom, z))
    pick = nx > 0 ? (p) => p.x : (p) => -p.x
  } else if (ny !== 0) {
    pts = circleIntersect(CENTERS[0], radiusForLevel(geom, x), CENTERS[2], radiusForLevel(geom, z))
    pick = ny > 0 ? (p) => -p.y : (p) => p.y
  } else {
    pts = circleIntersect(CENTERS[0], radiusForLevel(geom, x), CENTERS[1], radiusForLevel(geom, y))
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

// 初始贴纸：每面沿 in-plane 两轴遍历 geom.levels × geom.levels。
// 因 levels 已排除中层（2 阶只有 ±1），2 阶自动只生成 4 角块（24 贴纸）、
// 3 阶生成 9 块（54 贴纸）、4 阶生成 16 块（96 贴纸）——无需按阶特殊分支。
export function initStickers(order: CubeOrder = 3): Sticker[] {
  const geom = ORDER_GEOMS[order]
  const out: Sticker[] = []
  let id = 0
  for (let f = 0; f < 6; f++) {
    const normal = FACE_NORMALS[f]
    const axes = [0, 1, 2].filter((i) => normal[i] === 0)
    for (const cu of geom.levels) {
      for (const cv of geom.levels) {
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
export function rotVec(v: V3, axis: Axis, deg: number): V3 {
  const t = (deg * Math.PI) / 180
  const c = Math.round(Math.cos(t))
  const s = Math.round(Math.sin(t))
  const [x, y, z] = v
  if (axis === 0) return [x, y * c - z * s, y * s + z * c]
  if (axis === 1) return [x * c + z * s, y, -x * s + z * c]
  return [x * c - y * s, x * s + y * c, z]
}

// 每个同心圆组在屏幕坐标系中的正向，与 3D 右手坐标系的正向并不相同。
// 这个表把实际的层旋转角转换为屏幕上圆周 dot 应保持的统一方向。
// 实测（每个转动 12~13 个圆周 dot 的自然短弧方向多数派）：
// U/F/R 顺时针、D/L/B 逆时针 → 三个轴均为 -1。
// 该方向仅与「轴」有关，与阶数无关。
export const SCREEN_TURN_ORIENTATION: readonly [number, number, number] = [-1, -1, -1]

// atan2 在 -π/π 处断开，两个几乎相邻的角度可能差出 ~2π。
// 三步归一：
//   1. 把角差折叠到 (-π, π]（最短几何弧）；
//   2. 若最短弧方向与本次转动的统一方向（direction，+1/-1）相反，
//      加减一整圈 2π 展开到正确方向；
//   3. 角差为 0 时保持原角度，避免方向修正引入 ±TAU 的假转动。
// 这样同一圆周上的 dot 不会仅因跨越 ±π 分支而反向，也不会绕远圈。
export function directedCircleAngle(theta0: number, theta1: number, direction: number): number {
  let delta = ((((theta1 - theta0 + Math.PI) % TAU) + TAU) % TAU) - Math.PI
  if (Math.abs(delta) < 1e-9) return theta0
  if (delta * direction < 0) delta += direction * TAU
  return theta0 + delta
}
