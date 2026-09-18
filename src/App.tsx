import { useEffect } from 'react'
import { ConcentricCircle } from '@/components/cube/ConcentricCircle'
import { MoveControls } from '@/components/cube/MoveControls'
import { TwistyPlayerView } from '@/components/cube/TwistyPlayerView'
import { type CubeOrder, ORDER_GEOMS, SUPPORTED_ORDERS } from '@/lib/cube'
import { useCubeStore } from '@/store/cubeStore'

export default function App() {
  const doMove = useCubeStore((s) => s.doMove)
  const order = useCubeStore((s) => s.order)
  const setOrder = useCubeStore((s) => s.setOrder)

  // 键盘操作：当前阶支持的记号。2/3 阶用 U/D/L/R/F/B（3 阶另含 M/E/S），4 阶外层同前、
  // 宽两层用小写 u/d/l/r/f/b。单字母才可触发；Shift 为逆时针（′）。
  // 动作来自全局 store，组件无本地状态。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const raw = e.key
      if (raw.length !== 1 || !/[a-zA-Z]/.test(raw)) return
      // 4 阶优先匹配小写宽两层（u/d/l/r/f/b），其余按大写外层；Shift 一律为逆时针。
      const faceMoves = ORDER_GEOMS[useCubeStore.getState().order].faceMoves
      const upper = raw.toUpperCase()
      const candidate = raw in faceMoves ? raw : upper in faceMoves ? upper : null
      if (candidate) doMove(e.shiftKey ? `${candidate}'` : candidate)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [doMove])

  return (
    <div className='flex h-screen flex-col bg-zinc-950 text-zinc-100'>
      <header className='flex items-center justify-between border-zinc-800 border-b px-6 py-3'>
        <h1 className='font-semibold text-lg tracking-tight'>魔方 · 同心圆可视化</h1>
        <div className='flex items-center gap-3'>
          <div className='flex items-center gap-1 rounded-lg border border-zinc-800 p-1'>
            {SUPPORTED_ORDERS.map((o: CubeOrder) => (
              <button
                key={o}
                type='button'
                onClick={() => setOrder(o)}
                className={`rounded-md px-3 py-1 font-mono text-sm transition-colors ${
                  o === order
                    ? 'bg-blue-600 text-white'
                    : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
                }`}
              >
                {o}阶
              </button>
            ))}
          </div>
        </div>
      </header>

      <main className='flex min-h-0 flex-1 gap-4 p-4'>
        <section className='flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900'>
          <div className='min-h-0 flex-1'>
            <TwistyPlayerView />
          </div>
          <div className='border-zinc-800 border-t p-3'>
            <MoveControls />
          </div>
        </section>

        <section className='flex min-w-0 flex-1 items-center justify-center rounded-xl border border-zinc-800 bg-zinc-900 p-2'>
          <ConcentricCircle />
        </section>
      </main>
    </div>
  )
}
