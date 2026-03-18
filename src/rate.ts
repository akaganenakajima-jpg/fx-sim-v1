// frankfurter.app から USD/JPY の現在レートを取得

interface FrankfurterResponse {
  rates: { JPY: number };
}

export async function getUSDJPY(): Promise<number> {
  const res = await fetch('https://api.frankfurter.app/latest?from=USD&to=JPY');
  if (!res.ok) {
    throw new Error(`frankfurter.app error: ${res.status}`);
  }
  const data = await res.json<FrankfurterResponse>();
  return data.rates.JPY;
}
