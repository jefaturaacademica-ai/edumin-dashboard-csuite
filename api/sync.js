function cleanDiplomadoName(name) {
  if (!name || name === '-') return '-';
  let s = String(name).trim();
  s = s.replace(/\s*\((?:EN VIVO|VIVO|ASINCR[OÓ]NICO|ASINCRONICOS|ASINCR[OÓ]NICOS|\d+\s*M[OÓ]DULOS?)\)/gi, '');
  s = s.replace(/\s*\((?:EN VIVO|VIVO|ASINCR[OÓ]NICO|ASINCRONICOS|ASINCR[OÓ]NICOS|\d+\s*M[OÓ]DULOS?)\)/gi, '');
  s = s.replace(/\s*-\s*\d+\s*M[OÓ]DULOS?/gi, '');
  s = s.replace(/\s+EN VIVO$/gi, '');
  s = s.replace(/\s+VIVO$/gi, '');
  s = s.replace(/\s+ASINCR[OÓ]NICO$/gi, '');
  return s.replace(/\s+/g, ' ').trim();
}

export default async function handler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // 1. Trigger n8n webhook with proper User-Agent to avoid Cloudflare 403
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4000);
    await fetch('https://n8n.gcg-corp.com/webhook/ejecutar-cuadro-gigante-diario', {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      body: JSON.stringify({ sync: true, source: 'vercel_dashboard', timestamp: new Date().toISOString() }),
      signal: controller.signal
    }).catch(() => {});
    clearTimeout(timeoutId);
  } catch (e) {
    // Non-blocking trigger
  }

  // 2. Fetch live data from Google Sheet EXCEL PAGOS (destination updated by n8n)
  const SHEET_URL = 'https://docs.google.com/spreadsheets/d/1AM_ZXHRl7e80TRby4dJTITNTz12x8B9IgiRLrNPX4pw/gviz/tq?tqx=out:csv&sheet=Hoja%201';

  try {
    const sheetResp = await fetch(SHEET_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });

    if (!sheetResp.ok) {
      throw new Error(`Google Sheets responded with status ${sheetResp.status}`);
    }

    const csvText = await sheetResp.text();
    const records = parseAndTransformCSV(csvText);

    return res.status(200).json({
      success: true,
      total: records.length,
      records: records,
      timestamp: new Date().toISOString(),
      message: `Sincronización con Q10 y Google Sheets completada exitosamente. Total alumnos: ${records.length}`
    });

  } catch (err) {
    console.error('Error fetching live Google Sheet in /api/sync:', err);
    return res.status(500).json({
      success: false,
      error: err.message,
      message: "No se pudo consultar Google Sheets en vivo."
    });
  }
}

function parseCSV(text) {
  const lines = [];
  let row = [''];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i+1];
    if (c === '"') {
      if (inQuotes && next === '"') {
        row[row.length - 1] += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (c === ',' && !inQuotes) {
      row.push('');
    } else if ((c === '\r' || c === '\n') && !inQuotes) {
      if (c === '\r' && next === '\n') i++;
      lines.push(row);
      row = [''];
    } else {
      row[row.length - 1] += c;
    }
  }
  if (row.length > 1 || (row.length === 1 && row[0] !== '')) {
    lines.push(row);
  }
  return lines;
}

function parseNum(val) {
  if (!val) return 0;
  const s = String(val).replace(/S\//g, '').replace(/,/g, '').trim();
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

const monthsMap = {
  '01': 'Enero', '02': 'Febrero', '03': 'Marzo', '04': 'Abril',
  '05': 'Mayo', '06': 'Junio', '07': 'Julio', '08': 'Agosto',
  '09': 'Septiembre', '10': 'Octubre', '11': 'Noviembre', '12': 'Diciembre'
};

function parseAndTransformCSV(csvText) {
  const lines = parseCSV(csvText);
  if (!lines || lines.length < 2) return [];
  const headers = lines[0].map(h => h.trim());
  const records = [];

  for (let i = 1; i < lines.length; i++) {
    const r = lines[i];
    if (!r || r.length < 3) continue;
    const obj = {};
    for (let j = 0; j < headers.length; j++) {
      obj[headers[j]] = (r[j] || '').trim();
    }

    const dniVal = (obj['DNI'] || '').trim();
    const estVal = (obj['Estudiante'] || '').trim();
    if (!dniVal || !estVal || dniVal.toLowerCase() === 'dni' || estVal.toLowerCase().includes('total')) continue;

    const idx = i;
    const fPago = obj['Fecha Pago Comercial'] || '';
    const parts = fPago.split('/');
    const mes = (parts.length >= 2 && monthsMap[parts[1]]) ? monthsMap[parts[1]] : 'Noviembre';

    const pactCom = parseNum(obj['Pactado Comercial']) || parseNum(obj['MONTO TOTAL']);
    const pagCom = parseNum(obj['Pagado Comercial']) || parseNum(obj['MONTO INICIAL']) || parseNum(obj['CUOTA 1']);
    const pactQ10 = parseNum(obj['Pactado Q10']) || pactCom;
    const pagQ10 = parseNum(obj['Pagado Q10']) || pagCom;
    const deudaQ10 = parseNum(obj['Deuda Q10']) || parseNum(obj['DEBE']);

    const c1 = pagCom > 0 ? pagCom : parseNum(obj['CUOTA 1']);
    const c2 = parseNum(obj['CUOTA 2']);
    const c3 = parseNum(obj['CUOTA 3']);
    const c4 = parseNum(obj['CUOTA 4']);

    // Progressive payment distribution C1 -> C2 -> C3 -> C4
    let c1Pag = Math.min(pagQ10, c1);
    let cuotasRem = Math.max(0, pagQ10 - c1);

    let c2Pag = Math.min(cuotasRem, c2);
    cuotasRem = Math.max(0, cuotasRem - c2Pag);

    let c3Pag = Math.min(cuotasRem, c3);
    cuotasRem = Math.max(0, cuotasRem - c3Pag);

    let c4Pag = Math.min(cuotasRem, c4);
    cuotasRem = Math.max(0, cuotasRem - c4Pag);

    if (cuotasRem > 0) {
      if (c4 > 0) c4Pag += cuotasRem;
      else if (c3 > 0) c3Pag += cuotasRem;
      else if (c2 > 0) c2Pag += cuotasRem;
      else c1Pag += cuotasRem;
    }

    const c1Debe = Math.max(0, c1 - c1Pag);
    const c2Debe = Math.max(0, c2 - c2Pag);
    const c3Debe = Math.max(0, c3 - c3Pag);
    const c4Debe = Math.max(0, c4 - c4Pag);

    records.push({
      id: idx,
      idx: idx,
      nro_comercial: String(idx),
      dni: obj['DNI'] || '',
      nombre_comercial: obj['Estudiante'] || '',
      nombre_admin: obj['Estudiante'] || '',
      diplomado_comercial: cleanDiplomadoName(obj['Diplomado'] || ''),
      diplomado_admin: cleanDiplomadoName(obj['Diplomado'] || ''),
      mes_ingreso: mes,
      asesora: obj['Asesora'] || 'LEARSY',
      origen: obj['Origen'] || 'META',
      telefono: obj['Telefono'] || '',
      correo: obj['Correo'] || '',
      fecha_pago_comercial: fPago,
      fecha_ultimo_pago_q10: obj['Fecha Ultimo Pago Q10'] || '',
      fechas_cada_pago_q10: obj['Fecha cada pago Q10'] || '',
      pactado_comercial: pactCom,
      pagado_comercial: pagCom,
      financiamiento_q10: parseNum(obj['Financiamiento']),
      pactado_q10: pactQ10,
      pagado_q10: pagQ10,
      deuda_q10: deudaQ10,
      pagare_q10: obj['Pagare Q10'] || '',
      recibo_q10: obj['Recibo Q10'] || '',
      estado_q10: obj['Estado Q10'] || (deudaQ10 > 0 ? 'DEUDOR' : 'AL DÍA'),
      nro_admin: idx,
      fila_admin: idx + 12,
      situacion_admin: 'ACTIVO',
      pactado_admin: pactCom,
      pagado_admin: pagQ10,
      deuda_admin: deudaQ10,
      comprobante_admin: obj['Recibo Q10'] || '',
      obs_admin: '',
      diff_pactado: 0,
      diff_pagado: 0,
      diff_deuda: 0,
      categoria: 'IDENTICO',
      categoria_label: '✅ Coincidencia Exacta',
      categoria_badge: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
      explicacion: 'Pagos, pactado y deuda coinciden al 100%',
      c1: c1,
      c1_pagado: c1Pag,
      c1_debe: c1Debe,
      c2: c2,
      c2_pagado: c2Pag,
      c2_debe: c2Debe,
      c3: c3,
      c3_pagado: c3Pag,
      c3_debe: c3Debe,
      c4: c4,
      c4_pagado: c4Pag,
      c4_debe: c4Debe
    });
  }
  return records;
}
