// test/agent/notifier.test.js
import { describe, it, expect, vi } from 'vitest'
import { avisarSinClasificar } from '../../src/agent/notifier.js'

const expense = { merchant: 'Transferencia · 999', amount: 1000, currency: 'ARS' }

describe('avisarSinClasificar', () => {
  it('con el flag apagado no manda nada', async () => {
    const send = vi.fn()
    await avisarSinClasificar(expense, { enabled: false, to: '549', send })
    expect(send).not.toHaveBeenCalled()
  })

  it('con el flag prendido manda el aviso por WhatsApp', async () => {
    const send = vi.fn().mockResolvedValue({})
    await avisarSinClasificar(expense, { enabled: true, to: '549', send })
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0]).toBe('549')
    expect(send.mock.calls[0][1]).toContain('sin clasificar')
  })
})
