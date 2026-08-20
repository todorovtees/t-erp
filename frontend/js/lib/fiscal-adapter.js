// T-ERP — Fiscal device abstraction (spec §24).
//
// "Не връзвай бизнес логиката директно към конкретен модел" — the spec asks
// for an adapter interface so business logic (POS) never talks to a
// specific fiscal printer model directly. This file IS that interface. What
// it does NOT have is a real hardware driver — there's no physical fiscal
// device to test one against, so shipping a driver claiming to talk to real
// hardware would be dishonest. MockFiscalDriver logs a plausible response
// and lets development/demo proceed; a real driver (usually vendor SDK/COM
// port/network protocol specific to the device model) plugs in by
// implementing the same three methods below, with zero changes needed to
// POS or any other calling code.

/**
 * @interface FiscalDriver
 * issueReceipt({ documentNo, items, total, vatTotal, paymentMethod }) -> Promise<{ fiscalNumber, raw }>
 * storno(fiscalNumber) -> Promise<{ ok, raw }>
 * dailyReport() -> Promise<{ raw }>
 */

export class MockFiscalDriver {
  async issueReceipt({ documentNo }) {
    // Simulates a device round-trip. A real driver would talk to the actual
    // device (serial/USB/network) here and return whatever it reports.
    await new Promise((r) => setTimeout(r, 150));
    const fiscalNumber = 'MOCK-' + Math.floor(Math.random() * 1e8).toString().padStart(8, '0');
    return { fiscalNumber, raw: { simulated: true, documentNo, issuedAt: new Date().toISOString() } };
  }

  async storno(fiscalNumber) {
    await new Promise((r) => setTimeout(r, 100));
    return { ok: true, raw: { simulated: true, stornoOf: fiscalNumber } };
  }

  async dailyReport() {
    return { raw: { simulated: true, note: 'Mock driver has no real Z-report data.' } };
  }
}

export class FiscalDeviceAdapter {
  /** @param {FiscalDriver} driver */
  constructor(driver) {
    this.driver = driver;
  }

  async issueReceipt(saleData) {
    try {
      const result = await this.driver.issueReceipt(saleData);
      return { status: 'issued', ...result };
    } catch (err) {
      return { status: 'error', error: String(err) };
    }
  }

  async storno(fiscalNumber) {
    try {
      const result = await this.driver.storno(fiscalNumber);
      return { status: result.ok ? 'storno' : 'error', ...result };
    } catch (err) {
      return { status: 'error', error: String(err) };
    }
  }
}

/** Currently always returns the mock driver. Swap this single line once a
 *  real driver exists — nothing else in the app needs to change. */
export function getFiscalAdapter() {
  return new FiscalDeviceAdapter(new MockFiscalDriver());
}
