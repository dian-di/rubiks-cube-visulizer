// 转动操作区：FACE_KEYS 的顺/逆时针按钮 + 打乱/复位，并展示历史手序。
// 全部通过全局 store 的引擎动作触发，组件自身不持有任何魔方状态。

import { Button } from '@/components/ui/button'
import { useCubeStore } from '@/store/cubeStore'
import { FACE_KEYS } from '@/lib/cube'

export function MoveControls() {
  const history = useCubeStore((s) => s.history)
  const doMove = useCubeStore((s) => s.doMove)
  const scramble = useCubeStore((s) => s.scramble)
  const reset = useCubeStore((s) => s.reset)

  return (
    <div>
      <div className='mb-2 h-4 truncate font-mono text-xs text-zinc-400'>{history.join(' ')}</div>
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
  )
}
