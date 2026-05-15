// messages.js — connection-gated DM. List conversations on the left,
// active conversation on the right. Realtime via Supabase channels for
// the open conversation; light polling on the list for new threads.
// Requires supabase.js + auth.js loaded first.

(function () {
  if (!window.maia || !window.maia.client) return;
  var supabase = window.maia.client;

  var sessionUserId = null;
  var conversations = [];        // [{ id, other, last_message_at, intro_id, unread }]
  var activeConvId = null;
  var activeChannel = null;

  (async function init() {
    var session = await window.maia.requireAuth();
    if (!session) return;
    sessionUserId = session.user.id;

    bindCompose();
    bindBack();

    await loadConversations();
    var params = new URLSearchParams(window.location.search);
    var openId = params.get('c');
    var withId = params.get('with');
    if (openId) {
      await openConversation(openId);
    } else if (withId) {
      var match = conversations.find(function (c) { return c.other && c.other.id === withId; });
      if (match) {
        await openConversation(match.id);
      } else {
        // No conversation row yet. Broker-route accepted intros and any
        // "Say hi" entry from the connections grid land here. Try to create
        // the row — RLS gates it on are_connected().
        var newId = await findOrCreateConversationWith(withId);
        if (newId) {
          await loadConversations();
          await openConversation(newId);
        } else {
          console.warn('Could not open conversation with', withId);
        }
      }
    } else if (conversations.length && window.matchMedia('(min-width: 700px)').matches) {
      await openConversation(conversations[0].id, { replaceUrl: true });
    }
  })();

  async function findOrCreateConversationWith(otherId) {
    // The conversations table has a check constraint member_a < member_b
    // (uuid ordering) and a unique pair index. Order before inserting.
    var a = sessionUserId < otherId ? sessionUserId : otherId;
    var b = sessionUserId < otherId ? otherId : sessionUserId;
    var ins = await supabase.from('conversations')
      .insert({ member_a: a, member_b: b })
      .select('id')
      .maybeSingle();
    if (!ins.error && ins.data) return ins.data.id;
    // Race: another tab created it. Re-fetch.
    var lookup = await supabase.from('conversations')
      .select('id').eq('member_a', a).eq('member_b', b).maybeSingle();
    if (lookup.data) return lookup.data.id;
    return null;
  }

  // ── Conversation list ────────────────────────────────────────
  async function loadConversations() {
    var listEl = document.getElementById('msg-list');
    if (!listEl) return;

    var res = await supabase
      .from('conversations')
      .select(
        'id, member_a, member_b, last_message_at, intro_id,' +
        'a:members!member_a(id,full_name,headline,avatar_url),' +
        'b:members!member_b(id,full_name,headline,avatar_url)'
      )
      .order('last_message_at', { ascending: false });

    if (res.error) {
      console.error('loadConversations error:', res.error);
      listEl.innerHTML = '<p class="msg-empty">Could not load conversations.</p>';
      return;
    }

    conversations = (res.data || []).map(function (c) {
      var other = c.member_a === sessionUserId ? c.b : c.a;
      return {
        id: c.id,
        other: other,
        last_message_at: c.last_message_at,
        intro_id: c.intro_id
      };
    });

    // Pull unread counts in one query: count messages addressed to me
    // (sender != me) with read_at null per conversation.
    if (conversations.length) {
      var unreadRes = await supabase
        .from('messages')
        .select('conversation_id, sender_id, read_at')
        .neq('sender_id', sessionUserId)
        .is('read_at', null)
        .in('conversation_id', conversations.map(function (c) { return c.id; }));
      if (!unreadRes.error) {
        var counts = {};
        (unreadRes.data || []).forEach(function (m) {
          counts[m.conversation_id] = (counts[m.conversation_id] || 0) + 1;
        });
        conversations.forEach(function (c) { c.unread = counts[c.id] || 0; });
      }
    }

    renderConversationList();
  }

  function renderConversationList() {
    var listEl = document.getElementById('msg-list');
    if (!listEl) return;
    listEl.innerHTML = '';
    if (!conversations.length) {
      listEl.innerHTML = '<p class="msg-empty">No conversations yet. Say hi to a connection from your <a href="dashboard.html#connections-section" style="color:var(--gold);">dashboard</a>.</p>';
      return;
    }
    conversations.forEach(function (c) { listEl.appendChild(buildConversationRow(c)); });
  }

  function buildConversationRow(c) {
    var row = document.createElement('a');
    row.className = 'msg-list-row' + (c.id === activeConvId ? ' is-active' : '');
    row.href = 'messages.html?c=' + encodeURIComponent(c.id);
    row.dataset.convId = c.id;
    row.addEventListener('click', function (e) {
      e.preventDefault();
      openConversation(c.id);
    });

    var avatar = document.createElement('div');
    avatar.className = 'msg-list-avatar';
    window.maia.fillAvatar(avatar, c.other);
    row.appendChild(avatar);

    var info = document.createElement('div');
    info.className = 'msg-list-info';

    var name = document.createElement('p');
    name.className = 'msg-list-name';
    name.textContent = c.other ? c.other.full_name : '—';
    info.appendChild(name);

    var sub = document.createElement('p');
    sub.className = 'msg-list-sub';
    sub.textContent = c.other && c.other.headline ? c.other.headline : '';
    info.appendChild(sub);

    row.appendChild(info);

    var meta = document.createElement('div');
    meta.className = 'msg-list-meta';
    meta.appendChild(textEl('span', 'msg-list-time', relativeTime(c.last_message_at)));
    if (c.unread) {
      var dot = textEl('span', 'msg-list-unread', String(c.unread));
      meta.appendChild(dot);
    }
    row.appendChild(meta);

    return row;
  }

  // ── Open conversation ────────────────────────────────────────
  async function openConversation(convId, opts) {
    activeConvId = convId;

    if (!opts || !opts.replaceUrl) {
      var url = new URL(window.location.href);
      url.searchParams.set('c', convId);
      history.replaceState(null, '', url);
    }

    document.querySelectorAll('.msg-list-row').forEach(function (r) {
      r.classList.toggle('is-active', r.dataset.convId === convId);
    });

    var emptyEl = document.getElementById('msg-thread-empty');
    var threadEl = document.getElementById('msg-thread');
    if (emptyEl) emptyEl.hidden = true;
    if (threadEl) threadEl.hidden = false;

    document.getElementById('msg-layout').classList.add('msg-layout--showing-thread');

    var conv = conversations.find(function (c) { return c.id === convId; });
    if (conv && conv.other) {
      var avatarEl = document.getElementById('msg-thread-avatar');
      window.maia.fillAvatar(avatarEl, conv.other);
      var nameEl = document.getElementById('msg-thread-name');
      nameEl.textContent = conv.other.full_name || '—';
      nameEl.href = 'profile.html?id=' + encodeURIComponent(conv.other.id);
      document.getElementById('msg-thread-sub').textContent = conv.other.headline || '';
    }

    await loadMessages(convId);
    await markAsRead(convId);
    subscribeToConversation(convId);
  }

  async function loadMessages(convId) {
    var bodyEl = document.getElementById('msg-thread-body');
    if (!bodyEl) return;
    bodyEl.innerHTML = '<p class="msg-empty">Loading…</p>';

    var res = await supabase
      .from('messages')
      .select('id, conversation_id, sender_id, body, created_at, read_at')
      .eq('conversation_id', convId)
      .order('created_at', { ascending: true });

    bodyEl.innerHTML = '';
    if (res.error) {
      bodyEl.innerHTML = '<p class="msg-empty">Could not load messages.</p>';
      return;
    }
    var msgs = res.data || [];
    if (!msgs.length) {
      bodyEl.innerHTML = '<p class="msg-empty">No messages yet. Say hi.</p>';
      return;
    }
    msgs.forEach(function (m) { bodyEl.appendChild(buildMessageBubble(m)); });
    scrollThreadToBottom();
  }

  function buildMessageBubble(m) {
    var wrap = document.createElement('div');
    wrap.className = 'msg-bubble-wrap ' + (m.sender_id === sessionUserId ? 'mine' : 'theirs');
    wrap.dataset.messageId = m.id;

    var bubble = document.createElement('div');
    bubble.className = 'msg-bubble';
    bubble.textContent = m.body;
    wrap.appendChild(bubble);

    var meta = document.createElement('p');
    meta.className = 'msg-bubble-meta';
    meta.textContent = relativeTime(m.created_at);
    wrap.appendChild(meta);

    return wrap;
  }

  async function markAsRead(convId) {
    // Mark all incoming, unread messages in this conversation as read.
    await supabase
      .from('messages')
      .update({ read_at: new Date().toISOString() })
      .eq('conversation_id', convId)
      .neq('sender_id', sessionUserId)
      .is('read_at', null);

    // Update local state + re-render the list to clear the unread dot.
    var conv = conversations.find(function (c) { return c.id === convId; });
    if (conv) conv.unread = 0;
    renderConversationList();
  }

  // ── Send ────────────────────────────────────────────────────
  function bindCompose() {
    var form = document.getElementById('msg-compose');
    var input = document.getElementById('msg-input');
    var btn = document.getElementById('msg-send');
    if (!form || !input || !btn) return;

    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      var text = (input.value || '').trim();
      if (!text || !activeConvId) return;
      btn.disabled = true;
      var prev = btn.textContent;
      btn.textContent = '…';

      var res = await supabase.from('messages').insert({
        conversation_id: activeConvId,
        sender_id: sessionUserId,
        body: text
      }).select().single();

      btn.disabled = false;
      btn.textContent = prev;

      if (res.error) {
        console.error('send failed:', res.error);
        alert('Could not send: ' + (res.error.message || 'unknown error'));
        return;
      }
      input.value = '';

      // Realtime will append the message; for instant feedback, render now too.
      var bodyEl = document.getElementById('msg-thread-body');
      if (bodyEl && !bodyEl.querySelector('[data-message-id="' + res.data.id + '"]')) {
        bodyEl.appendChild(buildMessageBubble(res.data));
        scrollThreadToBottom();
      }
      // Bump the conversation's last_message_at locally + re-sort.
      var conv = conversations.find(function (c) { return c.id === activeConvId; });
      if (conv) {
        conv.last_message_at = res.data.created_at;
        conversations.sort(function (a, b) {
          return (b.last_message_at || '').localeCompare(a.last_message_at || '');
        });
        renderConversationList();
      }
    });

    // Enter to send, Shift-Enter for newline.
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        form.requestSubmit();
      }
    });
  }

  function bindBack() {
    var back = document.getElementById('msg-back');
    if (!back) return;
    back.addEventListener('click', function (e) {
      e.preventDefault();
      var layout = document.getElementById('msg-layout');
      if (layout) layout.classList.remove('msg-layout--showing-thread');
    });
  }

  // ── Realtime ────────────────────────────────────────────────
  function subscribeToConversation(convId) {
    if (activeChannel) {
      try { supabase.removeChannel(activeChannel); } catch (e) { /* fall through */ }
      activeChannel = null;
    }
    activeChannel = supabase
      .channel('messages:' + convId)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'messages',
        filter: 'conversation_id=eq.' + convId
      }, function (payload) {
        var m = payload.new;
        // Skip if it's our own message — already rendered optimistically.
        if (m.sender_id === sessionUserId) return;
        var bodyEl = document.getElementById('msg-thread-body');
        if (!bodyEl || bodyEl.querySelector('[data-message-id="' + m.id + '"]')) return;
        bodyEl.appendChild(buildMessageBubble(m));
        scrollThreadToBottom();
        // Mark as read since the conversation is currently open.
        supabase.from('messages').update({ read_at: new Date().toISOString() }).eq('id', m.id);
      })
      .subscribe();
  }

  // ── Helpers ─────────────────────────────────────────────────
  function scrollThreadToBottom() {
    var bodyEl = document.getElementById('msg-thread-body');
    if (bodyEl) bodyEl.scrollTop = bodyEl.scrollHeight;
  }

  function textEl(tag, className, content) {
    var n = document.createElement(tag);
    if (className) n.className = className;
    if (content != null) n.textContent = content;
    return n;
  }

  function relativeTime(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d)) return '';
    var diff = Date.now() - d.getTime();
    var mins = Math.round(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + ' min ago';
    var hrs = Math.round(mins / 60);
    if (hrs < 24) return hrs + 'h ago';
    var days = Math.round(hrs / 24);
    if (days < 7) return days + 'd ago';
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
})();
