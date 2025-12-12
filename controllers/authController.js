import fetch from 'node-fetch';

export async function loginController(request, reply) {
  try {
    const { username, password } = request.body || {};
    if (!username || !password) {
      return reply
        .code(400)
        .headers({
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          Pragma: 'no-cache',
        })
        .send({ error: 'Missing username or password' });
    }

    const base = process.env.ADMIN_API_BASE;
    try {
      request.log.info({ base }, '[auth/login] ADMIN_API_BASE');
    } catch (_) {
      // ignore log errors
    }

    if (!base) {
      return reply
        .code(500)
        .headers({
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          Pragma: 'no-cache',
        })
        .send({ error: 'ADMIN_API_BASE is not configured' });
    }

    const upstreamUrl = `${base.replace(/\/$/, '')}/admin/auth/login`;
    const res = await fetch(upstreamUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });

    const raw = await res.text();
    let data = {};
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch (_) {
      data = {};
    }

    try {
      request.log.info(
        {
          url: upstreamUrl,
          status: res.status,
          raw,
        },
        '[auth/login] upstream response',
      );
    } catch (_) {
      // ignore log errors
    }

    if (!res.ok) {
      const msg = data?.message || data?.error || 'Login gagal';
      const code = data?.code || 'Error';
      return reply
        .code(res.status)
        .headers({
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          Pragma: 'no-cache',
        })
        .send({
          success: false,
          code,
          message: msg,
          upstreamStatus: res.status,
          upstreamRaw: process.env.NODE_ENV !== 'production' ? raw : undefined,
        });
    }

    const token = data?.token || data?.accessToken || data?.access_token;
    if (!token) {
      return reply.code(500).send({ error: 'Missing token from auth response' });
    }

    reply
      .headers({
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        Pragma: 'no-cache',
      })
      .setCookie('admin_token', token, {
        // Biarkan dapat diakses FE agar bisa dibaca via document.cookie
        httpOnly: false,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        path: '/',
        maxAge: 60 * 60 * 8,
      })
      .send({
        success: true,
        code: 'OK',
        message: 'Login berhasil',
        token,
        admin: data?.admin ?? null,
      });
  } catch (e) {
    request.log.error(e, 'Unexpected error in /auth/login');
    return reply
      .code(500)
      .headers({
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        Pragma: 'no-cache',
      })
      .send({ success: false, code: 'UnexpectedError', message: 'Unexpected error' });
  }
}
