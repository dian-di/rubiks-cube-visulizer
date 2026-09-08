import { useEffect } from 'react'
import { useCubeStore } from '@/store/cubeStore'
import { FACE_MOVES } from '@/lib/cube'
import { TwistyPlayerView } from '@/components/cube/TwistyPlayerView'
import { MoveControls } from '@/components/cube/MoveControls'
import { ConcentricCircle } from '@/components/cube/ConcentricCircle'

export default function App() {
  const doMove = useCubeStore((s) => s.doMove)

  // 键盘操作：U/D/L/R/F/B/M/E/S，Shift 为逆时针。动作来自全局 store，组件无本地状态。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const k = e.key.toUpperCase()
      if (k in FACE_MOVES) doMove(e.shiftKey ? `${k}'` : k)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [doMove])

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
