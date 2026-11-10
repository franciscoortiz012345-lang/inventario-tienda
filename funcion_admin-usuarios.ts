// =====================================================================
// INVENTARIO TIENDA · Función "admin-usuarios" (Supabase Edge Function)
// Solo el administrador puede usarla. Crea, edita, bloquea y elimina cuentas.
// Pegar en Supabase → Edge Functions → Deploy a new function → Via Editor
// Nombre de la función: admin-usuarios
// =====================================================================
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const responder = (cuerpo: unknown, estado = 200) =>
  new Response(JSON.stringify(cuerpo), { status: estado, headers: { ...cors, 'Content-Type': 'application/json' } });

const correoValido = (e: string) => /^\S+@\S+\.\S+$/.test(e);

// =====================================================================
// FACTURACIÓN ELECTRÓNICA CON FACTUS
// =====================================================================
const URL_FACTUS = { pruebas: 'https://api-sandbox.factus.com.co', produccion: 'https://api.factus.com.co' } as Record<string, string>;
const tokens = new Map<number, { token: string; vence: number; base: string }>();
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const f2 = (n: number) => r2(n).toFixed(2);

// Medio de pago de la app → código DIAN
const METODO_PAGO: Record<string, string> = { efectivo: '10', tarjeta: '48', nequi: '47', daviplata: '47', transferencia: '47', fiado: '10' };
// Unidad de la app → código de unidad de medida
const UNIDAD: Record<string, string> = { unidad: '94', paquete: '94', kilo: 'KGM', libra: 'LBR' };

function buscarLista(j: any): any[] {
  if (Array.isArray(j)) return j;
  if (Array.isArray(j?.data)) return j.data;
  if (Array.isArray(j?.data?.data)) return j.data.data;
  return [];
}
function textoError(j: any): string {
  const partes: string[] = [];
  if (j?.message) partes.push(String(j.message));
  const errs = j?.data?.errors || j?.errors;
  if (errs && typeof errs === 'object') {
    for (const [k, v] of Object.entries(errs)) partes.push(`${k}: ${Array.isArray(v) ? v.join(' ') : typeof v === 'object' ? JSON.stringify(v) : v}`);
  }
  return partes.join(' · ').slice(0, 900) || 'Error desconocido';
}
async function configFactus(sb: any, tiendaId: number) {
  const { data: t } = await sb.from('tiendas').select('fe_ambiente').eq('id', tiendaId).maybeSingle();
  const { data: cfg } = await sb.from('facturacion_config').select('*').eq('tienda_id', tiendaId).maybeSingle();
  if (!cfg?.client_id || !cfg?.client_secret || !cfg?.usuario || !cfg?.clave) throw new Error('Faltan las credenciales de Factus de esta tienda. Configúralas en el panel de administración.');
  return { base: URL_FACTUS[t?.fe_ambiente || 'pruebas'], cfg };
}
async function tokenFactus(tiendaId: number, base: string, cfg: any): Promise<string> {
  const c = tokens.get(tiendaId);
  if (c && c.base === base && c.vence > Date.now() + 30000) return c.token;
  const r = await fetch(`${base}/oauth/token`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'password', client_id: cfg.client_id, client_secret: cfg.client_secret, username: cfg.usuario, password: cfg.clave }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error('No se pudo iniciar sesión en Factus. Revisa las credenciales. (' + textoError(j) + ')');
  tokens.set(tiendaId, { token: j.access_token, vence: Date.now() + (Number(j.expires_in) || 600) * 1000, base });
  return j.access_token;
}

async function facturar(sb: any, userId: string, b: any) {
  const { data: ut } = await sb.from('usuarios_tienda').select('tienda_id, tiendas(estado, fe_activa, municipio)').eq('user_id', userId).maybeSingle();
  const { data: v } = await sb.from('ventas').select('*').eq('id', b.venta_id).maybeSingle();
  if (!v || !ut || v.tienda_id !== ut.tienda_id) return responder({ error: 'Venta no encontrada.' }, 404);
  if (ut.tiendas?.estado !== 'activa') return responder({ error: 'La tienda está suspendida.' }, 403);
  if (!ut.tiendas?.fe_activa) return responder({ error: 'La facturación electrónica no está activada para esta tienda.' }, 400);
  if (v.estado === 'anulada') return responder({ error: 'No se puede facturar una venta anulada.' }, 400);
  if (v.fe_estado === 'validada') return responder({ error: 'Esta venta ya tiene factura electrónica.' }, 400);
  if (v.fe_estado === 'pendiente' && v.fe_fecha && Date.now() - new Date(v.fe_fecha).getTime() < 60000)
    return responder({ error: 'Esta factura se está procesando. Espera un momento.' }, 409);

  // Cliente: el que se eligió, el de la venta o consumidor final
  let clienteId = v.cliente_id;
  if (v.medio_pago !== 'fiado' && b.cliente_id !== undefined) clienteId = b.cliente_id || null;
  let cli: any = null;
  if (clienteId) {
    const { data } = await sb.from('clientes').select('*').eq('id', clienteId).eq('tienda_id', v.tienda_id).maybeSingle();
    cli = data;
  }

  const intento = (v.fe_intentos || 0) + 1;
  await sb.from('ventas').update({ tipo_comprobante: 'electronica', fe_estado: 'pendiente', fe_fecha: new Date().toISOString(), fe_intentos: intento, fe_error: null, cliente_id: clienteId }).eq('id', v.id);
  const fallar = async (msg: string, estado = 400) => {
    await sb.from('ventas').update({ fe_estado: 'error', fe_error: msg }).eq('id', v.id);
    return responder({ error: msg }, estado);
  };

  try {
    const { base, cfg } = await configFactus(sb, v.tienda_id);
    const tk = await tokenFactus(v.tienda_id, base, cfg);

    // Ítems
    const { data: movs } = await sb.from('movimientos').select('cantidad, precio_unitario, iva, iva_excluido, productos(id, nombre, codigo_barras, unidad, iva, iva_excluido)').eq('venta_id', v.id).eq('tipo', 'venta');
    if (!movs?.length) return await fallar('La venta no tiene productos.');
    const subtotal = Number(v.subtotal) || 0, descuento = Number(v.descuento) || 0;
    const tasaDesc = subtotal > 0 ? r2(descuento / subtotal * 100) : 0;
    let calculado = 0;
    const items = movs.map((m: any) => {
      const p = m.productos || {};
      const excluido = m.iva_excluido ?? !!p.iva_excluido;      // IVA guardado al vender (o el actual del producto)
      const iva = excluido ? 0 : Number(m.iva ?? p.iva ?? 19);
      const precio = r2(Number(m.precio_unitario) / (1 + iva / 100)); // el precio de la app incluye IVA
      const cant = r2(Number(m.cantidad));
      const baseItem = r2(precio * cant * (1 - tasaDesc / 100));
      calculado += baseItem + r2(baseItem * iva / 100);
      return {
        code_reference: p.codigo_barras || `P${p.id}`,
        name: String(p.nombre || 'Producto').slice(0, 200),
        quantity: f2(cant),
        discount_rate: f2(tasaDesc),
        price: f2(precio),
        unit_measure_code: UNIDAD[p.unidad] || '94',
        standard_code: '999',
        taxes: [excluido ? { code: '01', rate: '0.00', is_excluded: true } : { code: '01', rate: f2(iva) }],
      };
    });
    const total = Number(v.total);
    const redondeo = r2(total - calculado);
    if (Math.abs(redondeo) > 500) return await fallar(`La diferencia de redondeo (${redondeo}) supera lo permitido. Revisa precios e IVA de los productos.`);

    // Cliente
    let customer: any;
    if (cli?.documento) {
      const juridica = cli.tipo_persona === '1';
      const docLimpio = String(cli.documento).split('-')[0].replace(/\D/g, '');
      customer = {
        identification_document_code: cli.tipo_documento || '13',
        identification: docLimpio,
        legal_organization_code: juridica ? '1' : '2',
        tribute_code: cli.tributo || 'ZZ',
        responsibilities: [cli.responsabilidad || 'R-99-PN'],
        country_code: 'CO',
        ...(cli.dv ? { dv: String(cli.dv) } : {}),
        ...(juridica ? { company: cli.nombre } : { names: cli.nombre }),
        ...(cli.nombre_comercial ? { trade_name: cli.nombre_comercial } : {}),
        ...(cli.direccion ? { address: cli.direccion } : {}),
        ...(cli.email ? { email: cli.email } : {}),
        ...(cli.telefono ? { phone: cli.telefono } : {}),
      };
      // Código DANE del municipio (5 dígitos): el del cliente o, si no tiene, el de la tienda
      const codMun = (x: unknown) => (String(x || '').match(/\b\d{5}\b/) || [])[0];
      const mun = codMun(cli.municipio) || codMun(ut.tiendas?.municipio);
      if (!mun) return await fallar('Falta el código del municipio del cliente: son 5 números del DANE (por ejemplo 54001 para Cúcuta o 11001 para Bogotá). Agrégalo en Clientes y fiados, botón Editar, campo Municipio, y vuelve a intentar.');
      customer.municipality_code = mun;
    } else {
      customer = { identification_document_code: '13', identification: '222222222222', legal_organization_code: '2', names: 'Consumidor final', tribute_code: 'ZZ', responsibilities: ['R-99-PN'], country_code: 'CO' };
    }

    // Pago
    const credito = v.medio_pago === 'fiado';
    const vence = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
    const payment_details = v.medio_pago === 'mixto' && Array.isArray(v.pagos) && v.pagos.length
      ? v.pagos.map((pg: any) => ({ payment_form: '1', payment_method_code: METODO_PAGO[pg.medio] || '10', amount: f2(Number(pg.valor)) }))
      : [{
          payment_form: credito ? '2' : '1',
          payment_method_code: METODO_PAGO[v.medio_pago] || '10',
          amount: f2(total),
          ...(credito ? { due_date: vence } : {}),
        }];

    const cuerpo: any = {
      reference_code: `T${v.tienda_id}-V${v.numero}-${intento}`,
      document: '01',
      operation_type: '10',
      send_email: !!customer.email,
      observation: `Venta #${v.numero}`,
      payment_details,
      cash_rounding_amount: f2(redondeo),
      customer,
      items,
    };
    if (cfg.numbering_range_id) cuerpo.numbering_range_id = Number(cfg.numbering_range_id);

    const r = await fetch(`${base}/v2/bills/validate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tk}`, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(cuerpo),
    });
    const j = await r.json().catch(() => ({}));
    const d = j?.data;
    if (!r.ok || !d?.number) return await fallar('Factus no aceptó la factura: ' + textoError(j));
    if (d.is_validated === false) {
      await sb.from('ventas').update({ fe_numero: d.number, fe_cufe: d.cufe, fe_qr: d.links?.qr, fe_url: d.links?.public_url }).eq('id', v.id);
      return await fallar('La DIAN no validó la factura: ' + textoError(j));
    }
    const avisos = d.errors && Object.keys(d.errors).length ? textoError({ errors: d.errors }) : null;
    await sb.from('ventas').update({
      fe_estado: 'validada', fe_numero: d.number, fe_cufe: d.cufe, fe_qr: d.links?.qr || null, fe_url: d.links?.public_url || null,
      fe_error: avisos, fe_fecha: new Date().toISOString(),
    }).eq('id', v.id);
    return responder({ ok: true, numero: d.number, cufe: d.cufe, qr: d.links?.qr, url: d.links?.public_url, avisos, total: d.totals?.total });
  } catch (e) {
    return await fallar((e as Error).message || String(e), 500);
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const url = Deno.env.get('SUPABASE_URL')!;
    const clave = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const sb = createClient(url, clave, { auth: { persistSession: false, autoRefreshToken: false } });

    // 1. ¿Quién llama?
    const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const { data: { user: yo }, error: eYo } = await sb.auth.getUser(token);
    if (eYo || !yo) return responder({ error: 'Tu sesión no es válida. Vuelve a entrar.' }, 401);
    const b = await req.json();

    // Facturar: lo puede hacer cualquier usuario de la tienda dueña de la venta
    if (b.accion === 'facturar') return await facturar(sb, yo.id, b);

    // Todo lo demás: solo el administrador
    const { data: adm } = await sb.from('administradores').select('user_id').eq('user_id', yo.id).maybeSingle();
    if (!adm) return responder({ error: 'Solo el administrador puede hacer esto.' }, 403);

    // ---------- FACTUS: ver / guardar / probar credenciales ----------
    if (b.accion === 'fe_ver') {
      const { data: c } = await sb.from('facturacion_config').select('*').eq('tienda_id', b.tienda_id).maybeSingle();
      return responder({ client_id: c?.client_id || '', usuario: c?.usuario || '', numbering_range_id: c?.numbering_range_id || null,
        tiene_secreto: !!c?.client_secret, tiene_clave: !!c?.clave });
    }
    if (b.accion === 'fe_guardar') {
      const { data: c } = await sb.from('facturacion_config').select('*').eq('tienda_id', b.tienda_id).maybeSingle();
      const fila = {
        tienda_id: b.tienda_id,
        client_id: String(b.client_id || '').trim() || null,
        usuario: String(b.usuario || '').trim() || null,
        client_secret: String(b.client_secret || '').trim() || c?.client_secret || null,
        clave: String(b.clave || '') || c?.clave || null,
        numbering_range_id: b.numbering_range_id ? Number(b.numbering_range_id) : null,
        actualizado_en: new Date().toISOString(),
      };
      const { error } = await sb.from('facturacion_config').upsert(fila);
      if (error) throw error;
      tokens.delete(Number(b.tienda_id));
      return responder({ ok: true });
    }
    if (b.accion === 'fe_probar') {
      const { base, cfg } = await configFactus(sb, Number(b.tienda_id));
      const tk = await tokenFactus(Number(b.tienda_id), base, cfg);
      const r = await fetch(`${base}/v2/numbering-ranges`, { headers: { Authorization: `Bearer ${tk}`, Accept: 'application/json' } });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return responder({ error: 'Factus respondió: ' + textoError(j) }, 400);
      const lista = buscarLista(j).map((x: any) => ({
        id: x.id, prefijo: x.prefix ?? '', documento: x.document?.name ?? x.document ?? '',
        desde: x.from ?? '', hasta: x.to ?? '', actual: x.current ?? '', activo: x.is_active ?? true,
      }));
      return responder({ ok: true, rangos: lista });
    }

    // ---------- LISTAR ----------
    if (b.accion === 'listar') {
      let q = sb.from('usuarios_tienda').select('user_id, tienda_id, rol, email, nombre, creado_en, softwares, tiendas(nombre)').order('creado_en');
      if (b.tienda_id) q = q.eq('tienda_id', b.tienda_id);
      const { data: filas, error } = await q;
      if (error) throw error;
      const cuentas: Record<string, any> = {};
      for (let pagina = 1; pagina < 50; pagina++) {
        const { data, error: e } = await sb.auth.admin.listUsers({ page: pagina, perPage: 1000 });
        if (e) throw e;
        data.users.forEach((u) => (cuentas[u.id] = u));
        if (data.users.length < 1000) break;
      }
      const ahora = Date.now();
      return responder({
        usuarios: (filas || []).map((f: any) => {
          const c = cuentas[f.user_id];
          return {
            ...f,
            tienda: f.tiendas?.nombre || '',
            ultimo_ingreso: c?.last_sign_in_at || null,
            bloqueado: !!(c?.banned_until && new Date(c.banned_until).getTime() > ahora),
            es_yo: f.user_id === yo.id,
          };
        }),
      });
    }

    // Lista de softwares válida para una cuenta
    const leerSoftwares = async (lista: unknown) => {
      if (!Array.isArray(lista)) return null;
      const cods = [...new Set(lista.map((x) => String(x)))];
      if (!cods.length) return { error: 'Elige al menos un software para la cuenta.' };
      const { data } = await sb.from('softwares').select('codigo').in('codigo', cods);
      if ((data || []).length !== cods.length) return { error: 'Hay un software que no existe en el catálogo.' };
      return { cods };
    };

    // ---------- CREAR ----------
    if (b.accion === 'crear') {
      const email = String(b.email || '').trim().toLowerCase();
      const nombre = String(b.nombre || '').trim();
      if (!nombre) return responder({ error: 'Escribe el nombre de la persona.' }, 400);
      if (!correoValido(email)) return responder({ error: 'El correo no es válido.' }, 400);
      if (String(b.password || '').length < 6) return responder({ error: 'La contraseña debe tener mínimo 6 caracteres.' }, 400);
      if (!['dueno', 'cajero'].includes(b.rol)) return responder({ error: 'Rol no válido.' }, 400);
      const { data: t } = await sb.from('tiendas').select('id').eq('id', b.tienda_id).maybeSingle();
      if (!t) return responder({ error: 'La tienda no existe.' }, 400);
      const { data: ya } = await sb.from('usuarios_tienda').select('user_id').ilike('email', email).maybeSingle();
      if (ya) return responder({ error: 'Ese correo ya tiene una cuenta.' }, 400);
      const sw = await leerSoftwares(b.softwares ?? ['inventario']);
      if (sw?.error) return responder({ error: sw.error }, 400);

      // El registro del correo permite que la base de datos acepte la cuenta nueva
      await sb.from('invitaciones').upsert({ tienda_id: b.tienda_id, email, rol: b.rol }, { onConflict: 'email' });
      const { data: creado, error: eC } = await sb.auth.admin.createUser({
        email, password: b.password, email_confirm: true, user_metadata: { nombre },
      });
      if (eC) {
        await sb.from('invitaciones').delete().eq('email', email);
        return responder({ error: /already|registered|exists/i.test(eC.message) ? 'Ese correo ya tiene una cuenta.' : eC.message }, 400);
      }
      const { error: eU } = await sb.from('usuarios_tienda').insert({ user_id: creado.user.id, tienda_id: b.tienda_id, rol: b.rol, email, nombre, softwares: sw?.cods || ['inventario'] });
      await sb.from('invitaciones').delete().eq('email', email);
      if (eU) { await sb.auth.admin.deleteUser(creado.user.id); throw eU; }
      return responder({ ok: true, user_id: creado.user.id });
    }

    // Para las demás acciones se necesita el usuario
    const id = String(b.user_id || '');
    const { data: fila } = await sb.from('usuarios_tienda').select('*').eq('user_id', id).maybeSingle();
    if (!fila) return responder({ error: 'Usuario no encontrado.' }, 404);
    const esYo = id === yo.id;

    // ---------- EDITAR ----------
    if (b.accion === 'editar') {
      const cambiosCuenta: Record<string, unknown> = {};
      const cambiosFila: Record<string, unknown> = {};
      if (b.nombre !== undefined) {
        const n = String(b.nombre).trim();
        if (!n) return responder({ error: 'El nombre no puede quedar vacío.' }, 400);
        cambiosFila.nombre = n; cambiosCuenta.user_metadata = { nombre: n };
      }
      if (b.email !== undefined) {
        const email = String(b.email).trim().toLowerCase();
        if (!correoValido(email)) return responder({ error: 'El correo no es válido.' }, 400);
        if (email !== String(fila.email).toLowerCase()) {
          const { data: otro } = await sb.from('usuarios_tienda').select('user_id').ilike('email', email).maybeSingle();
          if (otro) return responder({ error: 'Ese correo ya lo usa otra cuenta.' }, 400);
          cambiosCuenta.email = email; cambiosCuenta.email_confirm = true; cambiosFila.email = email;
        }
      }
      if (b.password) {
        if (String(b.password).length < 6) return responder({ error: 'La contraseña debe tener mínimo 6 caracteres.' }, 400);
        cambiosCuenta.password = b.password;
      }
      if (b.rol !== undefined && b.rol !== fila.rol) {
        if (esYo) return responder({ error: 'No puedes cambiar tu propio rol.' }, 400);
        if (!['dueno', 'cajero'].includes(b.rol)) return responder({ error: 'Rol no válido.' }, 400);
        cambiosFila.rol = b.rol;
      }
      if (b.tienda_id !== undefined && Number(b.tienda_id) !== Number(fila.tienda_id)) {
        if (esYo) return responder({ error: 'No puedes moverte de tienda a ti mismo.' }, 400);
        cambiosFila.tienda_id = Number(b.tienda_id);
      }
      if (b.softwares !== undefined) {
        const sw = await leerSoftwares(b.softwares);
        if (sw?.error) return responder({ error: sw.error }, 400);
        if (sw) cambiosFila.softwares = sw.cods;
      }
      if (Object.keys(cambiosCuenta).length) {
        const { error } = await sb.auth.admin.updateUserById(id, cambiosCuenta);
        if (error) return responder({ error: /already|exists/i.test(error.message) ? 'Ese correo ya lo usa otra cuenta.' : error.message }, 400);
      }
      if (Object.keys(cambiosFila).length) {
        const { error } = await sb.from('usuarios_tienda').update(cambiosFila).eq('user_id', id);
        if (error) throw error;
      }
      return responder({ ok: true });
    }

    // ---------- BLOQUEAR / DESBLOQUEAR ----------
    if (b.accion === 'bloquear') {
      if (esYo) return responder({ error: 'No puedes bloquear tu propia cuenta.' }, 400);
      const { error } = await sb.auth.admin.updateUserById(id, { ban_duration: b.bloquear ? '876000h' : 'none' });
      if (error) throw error;
      return responder({ ok: true });
    }

    // ---------- ELIMINAR ----------
    if (b.accion === 'eliminar') {
      if (esYo) return responder({ error: 'No puedes eliminar tu propia cuenta.' }, 400);
      const { error } = await sb.auth.admin.deleteUser(id);
      if (error) throw error;
      return responder({ ok: true });
    }

    return responder({ error: 'Acción desconocida.' }, 400);
  } catch (e) {
    return responder({ error: (e as Error).message || String(e) }, 500);
  }
});
