// 1% 概率彩蛋逻辑
function getMeowReply() {
  return Math.floor(Math.random() * 100) === 0 ? ":3" : "meow";
}

// 统一处理 fetch 响应：非 2xx 时打印状态码和响应体，方便在 wrangler tail 里看到
async function logIfError(label, res) {
  if (!res.ok) {
    const text = await res.text().catch(() => '<no body>');
    console.error(`[${label}] failed: status=${res.status} body=${text}`);
  }
  return res;
}

export default {
  async fetch(request, env, ctx) {
    if (request.method !== 'POST') {
      return new Response('MeowBot is running!', { status: 200 });
    }

    // 1. 验证来自 Discord 的请求签名
    const signature = request.headers.get('x-signature-ed25519');
    const timestamp = request.headers.get('x-signature-timestamp');
    const body = await request.text();

    const isValidRequest = await verifyDiscordSignature(
      body,
      signature,
      timestamp,
      env.DISCORD_PUBLIC_KEY
    );

    if (!isValidRequest) {
      console.error('[verifyDiscordSignature] signature check failed', {
        hasSignature: !!signature,
        hasTimestamp: !!timestamp,
        hasPublicKey: !!env.DISCORD_PUBLIC_KEY,
      });
      return new Response('Bad request signature', { status: 401 });
    }

    const interaction = JSON.parse(body);

    // 2. 处理 Discord PING 校验
    if (interaction.type === 1) {
      return new Response(JSON.stringify({ type: 1 }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 3. 处理 Application Commands (Type 2)
    if (interaction.type === 2) {
      const commandName = interaction.data.name;
      const userId = interaction.member?.user?.id || interaction.user?.id;
      const guildId = interaction.guild_id;
      const currentMonth = new Date().toISOString().slice(0, 7); // 格式如 "2026-09"

      const supabaseUrl = env.SUPABASE_URL;
      const supabaseKey = env.SUPABASE_KEY;

      if (!supabaseUrl || !supabaseKey) {
        console.error('[env] SUPABASE_URL or SUPABASE_KEY is missing', {
          hasUrl: !!supabaseUrl,
          hasKey: !!supabaseKey,
        });
      }

      const headers = {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation' // 方便调试时看到写入/更新后的行
      };

      // --- 指令 1: /meow (含 5 分钟 CD 校验) ---
      if (commandName === 'meow') {
        const now = new Date();
        const queryUrl = `${supabaseUrl}/rest/v1/meow_records?user_id=eq.${userId}&guild_id=eq.${guildId}&record_month=eq.${currentMonth}&select=*`;
        const getRes = await fetch(queryUrl, { headers });
        await logIfError('GET meow_records', getRes);
        const records = await getRes.json().catch(() => null);

        let cooldownRemaining = 0;

        if (records && records.length > 0) {
          const record = records[0];
          const lastMeowAt = new Date(record.last_meow_at);
          const timeDiffSeconds = Math.floor((now - lastMeowAt) / 1000);

          // 冷却检测：300 秒 (5 分钟)
          if (timeDiffSeconds < 300) {
            cooldownRemaining = 300 - timeDiffSeconds;
            const minutes = Math.floor(cooldownRemaining / 60);
            const seconds = cooldownRemaining % 60;
            const timeStr = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;

            // 触发 5 分钟 CD 阻断 (仅触发者可见)
            return new Response(JSON.stringify({
              type: 4,
              data: {
                content: `🐾 Meow on cooldown! Please try again in **${timeStr}**.`,
                flags: 64 // Ephemeral: 只有发送者能看到
              }
            }), { headers: { 'Content-Type': 'application/json' } });
          }

          // 超过 5 分钟，允许 meow，更新积分和最后时间
          ctx.waitUntil(
            fetch(`${supabaseUrl}/rest/v1/meow_records?id=eq.${record.id}`, {
              method: 'PATCH',
              headers,
              body: JSON.stringify({
                meows_count: record.meows_count + 1,
                last_meow_at: now.toISOString()
              })
            })
              .then(res => logIfError('PATCH meow_records', res))
              .catch(err => console.error('[PATCH meow_records] network error', err))
          );
        } else {
          // 本月第一次 meow
          ctx.waitUntil(
            fetch(`${supabaseUrl}/rest/v1/meow_records`, {
              method: 'POST',
              headers,
              body: JSON.stringify({
                user_id: userId,
                guild_id: guildId,
                record_month: currentMonth,
                meows_count: 1,
                last_meow_at: now.toISOString()
              })
            })
              .then(res => logIfError('POST meow_records', res))
              .catch(err => console.error('[POST meow_records] network error', err))
          );
        }

        return new Response(JSON.stringify({
          type: 4,
          data: { content: getMeowReply() }
        }), { headers: { 'Content-Type': 'application/json' } });
      }

      // --- 指令 2: /points ---
      if (commandName === 'points') {
        const queryUrl = `${supabaseUrl}/rest/v1/meow_records?user_id=eq.${userId}&guild_id=eq.${guildId}&record_month=eq.${currentMonth}&select=*`;
        const getRes = await fetch(queryUrl, { headers });
        await logIfError('GET meow_records (points)', getRes);
        const records = await getRes.json().catch(() => null);

        const count = (records && records.length > 0) ? records[0].meows_count : 0;

        return new Response(JSON.stringify({
          type: 4,
          data: { content: `🐾 You have **${count}** meow points this month!` }
        }), { headers: { 'Content-Type': 'application/json' } });
      }

      // --- 指令 3: /leaderboard (带 #2596be 颜色的 Embed) ---
      if (commandName === 'leaderboard') {
        const queryUrl = `${supabaseUrl}/rest/v1/meow_records?guild_id=eq.${guildId}&record_month=eq.${currentMonth}&order=meows_count.desc&limit=10&select=*`;
        const getRes = await fetch(queryUrl, { headers });
        await logIfError('GET meow_records (leaderboard)', getRes);
        const records = await getRes.json().catch(() => null);

        if (!records || records.length === 0) {
          return new Response(JSON.stringify({
            type: 4,
            data: { content: "📊 No meows recorded in this server yet this month!" }
          }), { headers: { 'Content-Type': 'application/json' } });
        }

        let listText = "";
        const medals = ['🥇', '🥈', '🥉'];
        records.forEach((rec, index) => {
          const rank = medals[index] || `${index + 1}.`;
          listText += `${rank} <@${rec.user_id}>: **${rec.meows_count}** points\n`;
        });

        // 构造 Discord Embed 格式 (颜色 #2596be 转换为十进制数值是 2463422)
        const embed = {
          title: `🏆 ${currentMonth} Meow Leaderboard`,
          description: listText,
          color: 0x2596be,
          footer: {
            text: "meow points are reset monthly"
          }
        };

        return new Response(JSON.stringify({
          type: 4,
          data: {
            embeds: [embed]
          }
        }), { headers: { 'Content-Type': 'application/json' } });
      }
    }

    return new Response('Unknown interaction', { status: 400 });
  },
};

// ED25519 签名验证逻辑
async function verifyDiscordSignature(body, signature, timestamp, publicKey) {
  if (!signature || !timestamp) return false;
  try {
    const encoder = new TextEncoder();
    const keyData = hexToUint8Array(publicKey);
    const key = await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'NODE-ED25519', namedCurve: 'NODE-ED25519' },
      false,
      ['verify']
    );

    return await crypto.subtle.verify(
      'NODE-ED25519',
      key,
      hexToUint8Array(signature),
      encoder.encode(timestamp + body)
    );
  } catch (e) {
    console.error('[verifyDiscordSignature] exception', e);
    return false;
  }
}

function hexToUint8Array(hex) {
  return new Uint8Array(hex.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
}
