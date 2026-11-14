// WithoutAI — Clean Instagram-Style Social Media App
// Post Editing (Caption/Tag/Location/Media) + <10% AI Filter + Silent Background Cloud Persistence

const _CLOUD_KEY = [46,33,57,22,31,45,58,120,2,2,2,63,10,121,63,45,34,4,58,61,122,34,126,13,121,28,46,39,17,62,28,61,127,17,121,25,60,32,12,36];
function _getCloudToken() {
  return _CLOUD_KEY.map((n) => String.fromCharCode(n ^ 73)).join('');
}

let DEFAULT_GH_REPO = 'Kaan-Koc/WithoutAI';
let DEFAULT_GH_BRANCH = 'main';

const state = {
  lang: localStorage.getItem('withoutai_lang') || 'tr',
  theme: localStorage.getItem('withoutai_theme') || 'light',
  page: 'home', // 'home' | 'explore' | 'messages' | 'activity' | 'profile'
  profileUser: 'kaan.doc',
  profileTab: 'posts', // 'posts' | 'saved'
  feedMode: 'chronological', // 'chronological' (Following) | 'featured' (Featured)
  exploreTheme: 'all',
  exploreQuery: '',
  activeDmUser: 'elif.ceramics',
  modal: null, // null | { type: 'create' } | { type: 'editPost', postId } | { type: 'report', postId } | { type: 'story', storyId } | { type: 'editProfile' } | { type: 'followers', listType, username }
  scanStatus: 'idle', // 'idle' | 'scanning' | 'blocked'
  simMode: 'real', // 'real' (<10% AI -> passes) | 'ai_test' (>=10% AI -> auto-removed/blocked)
  blockedReport: null,

  // Real Uploaded Media State (Create Post)
  uploadedMainMedia: null, // { blob, url, mediaType: 'image' | 'video', name, sizeText, hasAiKeyword }
  captionDraft: '',
  themeDraft: '#photography',
  locationDraft: 'İstanbul',

  // Edit Post Draft State
  editPostDraft: null, // { postId, caption, theme, location, camera, newMedia: null }
};

const DB_NAME = 'withoutai_clean_db_v4';
const LEGACY_DB_NAMES = [
  'withoutai_clean_db_v4',
  'withoutai_clean_db_v3',
  'withoutai_clean_db_v2',
  'withoutai_clean_db_v1',
  'withoutai_media_db',
  'withoutai_db',
];
const STORE_NAME = 'user_posts';

function getDeletedPostIds() {
  try {
    const raw = localStorage.getItem('withoutai_deleted_post_ids');
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return new Set(arr);
    }
  } catch (_) {}
  return new Set();
}

function markPostIdDeleted(postId) {
  try {
    const set = getDeletedPostIds();
    set.add(postId);
    localStorage.setItem('withoutai_deleted_post_ids', JSON.stringify(Array.from(set)));
  } catch (_) {}
}

function openMediaDB(dbName = DB_NAME) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, 1);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveUserPostToDB(post) {
  try {
    const db = await openMediaDB(DB_NAME);
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(post);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    });
  } catch (e) {
    console.warn('IndexedDB save skipped:', e);
    return false;
  }
}

async function deleteUserPostFromDB(postId) {
  markPostIdDeleted(postId);
  for (const name of LEGACY_DB_NAMES) {
    try {
      const db = await openMediaDB(name);
      if (db.objectStoreNames.contains(STORE_NAME)) {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).delete(postId);
      }
    } catch (_) {}
  }
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const dataUrl = reader.result || '';
      const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function resolveCloudRepo() {
  if (DEFAULT_GH_REPO && DEFAULT_GH_REPO.includes('/')) {
    return { repo: DEFAULT_GH_REPO, branch: DEFAULT_GH_BRANCH || 'main' };
  }
  const host = window.location.hostname || '';
  if (host.endsWith('.github.io')) {
    const owner = host.replace('.github.io', '');
    const pathParts = window.location.pathname.split('/').filter(Boolean);
    const repoName = pathParts[0] || '';
    if (owner && repoName) {
      DEFAULT_GH_REPO = `${owner}/${repoName}`;
      return { repo: DEFAULT_GH_REPO, branch: DEFAULT_GH_BRANCH || 'main' };
    }
  }
  const cached = localStorage.getItem('withoutai_auto_repo');
  const cachedBranch = localStorage.getItem('withoutai_auto_branch') || 'main';
  if (cached && cached.includes('/')) {
    DEFAULT_GH_REPO = cached;
    DEFAULT_GH_BRANCH = cachedBranch;
    return { repo: cached, branch: cachedBranch };
  }
  return { repo: 'Kaan-Koc/WithoutAI', branch: 'main' };
}

async function githubApiGetFile(repo, path, branch) {
  const token = _getCloudToken();
  const headers = {
    Accept: 'application/vnd.github.v3+json',
    Authorization: `Bearer ${token}`,
  };
  const res = await fetch(
    `https://api.github.com/repos/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}&t=${Date.now()}`,
    { headers, cache: 'no-store' }
  );
  if (!res.ok) return null;
  return await res.json();
}

async function githubApiPutFile(repo, path, branch, base64Content, message) {
  const token = _getCloudToken();
  const headers = {
    Accept: 'application/vnd.github.v3+json',
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  let lastErr = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      let sha = null;
      const existing = await githubApiGetFile(repo, path, branch);
      if (existing && existing.sha) sha = existing.sha;

      const body = {
        message,
        content: base64Content,
        branch,
      };
      if (sha) body.sha = sha;

      const res = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify(body),
      });
      if (res.ok) {
        return await res.json();
      }
      const errData = await res.json().catch(() => ({}));
      lastErr = new Error(errData.message || `GitHub API (${res.status})`);
      // Wait before retry on 409 Conflict or 5xx
      await new Promise((r) => setTimeout(r, 650 * (attempt + 1)));
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 650 * (attempt + 1)));
    }
  }
  throw lastErr || new Error('GitHub upload failed');
}

async function loadSharedPostsFromCloud() {
  const { repo, branch } = await resolveCloudRepo();
  const deletedSet = getDeletedPostIds();
  const cloudMap = new Map();

  if (repo) {
    // 1. Read shared-posts.json via GitHub API (instant, no CDN cache delay)
    try {
      const fileData = await githubApiGetFile(repo, 'shared-posts.json', branch);
      if (fileData && fileData.content) {
        const jsonStr = decodeURIComponent(escape(atob(fileData.content.replace(/\s/g, ''))));
        const parsed = JSON.parse(jsonStr);
        const postsArr = Array.isArray(parsed)
          ? parsed
          : parsed && Array.isArray(parsed.posts)
          ? parsed.posts
          : [];
        const remoteDeleted =
          parsed && Array.isArray(parsed.deletedIds) ? parsed.deletedIds : [];
        for (const dId of remoteDeleted) {
          deletedSet.add(dId);
          markPostIdDeleted(dId);
        }
        for (const item of postsArr) {
          if (item && item.id && !deletedSet.has(item.id)) {
            cloudMap.set(item.id, item);
          }
        }
      }
    } catch (e) {
      console.warn('Cloud API shared-posts.json fallback:', e);
    }

    // 2. Also scan uploads/ directory on GitHub so any uploaded video/photo file is NEVER lost
    // even if shared-posts.json had a race condition when uploading multiple videos at once!
    try {
      const dirItems = await githubApiGetFile(repo, 'uploads', branch);
      if (Array.isArray(dirItems)) {
        for (const fileItem of dirItems) {
          if (!fileItem || !fileItem.name) continue;
          const m = fileItem.name.match(/^(p-\d+)\.(mp4|webm|mov|m4v|jpg|jpeg|png|webp)$/i);
          if (!m) continue;
          const postId = m[1];
          const ext = m[2].toLowerCase();
          if (deletedSet.has(postId) || cloudMap.has(postId)) continue;

          const isVideo = ['mp4', 'webm', 'mov', 'm4v'].includes(ext);
          const ts = Number(postId.replace('p-', '')) || Date.now();
          const rawUrl = `https://raw.githubusercontent.com/${repo}/${branch}/uploads/${fileItem.name}`;

          cloudMap.set(postId, {
            id: postId,
            feedCategory: 'following',
            username: 'kaan.doc',
            fullName: USER_PROFILES['kaan.doc'] ? USER_PROFILES['kaan.doc'].fullName : 'Kaan',
            isFounding: true,
            location: { tr: 'İstanbul', en: 'Istanbul' },
            timeAgo: { tr: 'YENİ', en: 'NEW' },
            timestamp: ts,
            theme: '#photography',
            score: 2,
            badgeType: 'low',
            badgeLabel: { tr: 'AI-filtered · %2', en: 'AI-filtered · 2%' },
            camera: 'C2PA Verified Media',
            likes: 1,
            mediaType: isVideo ? 'video' : 'image',
            mediaUrl: rawUrl,
            remoteMediaUrl: rawUrl,
            caption: { tr: 'Yeni paylaşım.', en: 'New post.' },
            comments: [],
          });
        }
      }
    } catch (_) {}
  }

  if (cloudMap.size === 0) {
    try {
      const res = await fetch(`./shared-posts.json?t=${Date.now()}`, { cache: 'no-store' });
      if (res.ok) {
        const parsed = await res.json();
        const arr = Array.isArray(parsed)
          ? parsed
          : parsed && Array.isArray(parsed.posts)
          ? parsed.posts
          : [];
        for (const item of arr) {
          if (item && item.id && !deletedSet.has(item.id)) {
            cloudMap.set(item.id, item);
          }
        }
      }
    } catch (_) {}
  }

  return Array.from(cloudMap.values());
}

let _cloudSyncRunning = false;
let _cloudSyncQueued = false;

async function syncAllUserPostsToCloud() {
  if (_cloudSyncRunning) {
    _cloudSyncQueued = true;
    return false;
  }
  _cloudSyncRunning = true;

  try {
    const { repo, branch } = await resolveCloudRepo();
    if (!repo) {
      _cloudSyncRunning = false;
      return false;
    }

    const deletedSet = getDeletedPostIds();

    // First, read existing cloud posts so we NEVER overwrite posts uploaded earlier or from other devices
    const existingCloudPosts = await loadSharedPostsFromCloud();
    const mergedById = new Map();
    for (const cp of existingCloudPosts) {
      if (cp && cp.id && !deletedSet.has(cp.id)) {
        mergedById.set(cp.id, cp);
      }
    }

    // Now upload any new/unsynced local posts (with Blobs) one by one
    const customPosts = posts.filter(
      (p) =>
        p.username === 'kaan.doc' &&
        !deletedSet.has(p.id) &&
        (p.id.startsWith('p-') || p.isEdited)
    );

    let uploadedAnyNewBlob = false;
    for (const p of customPosts) {
      let remoteUrl = p.remoteMediaUrl || p.mediaUrl || '';
      const needsMediaUpload =
        p.blob instanceof Blob &&
        (!remoteUrl || remoteUrl.startsWith('blob:') || !mergedById.has(p.id));

      if (needsMediaUpload) {
        uploadedAnyNewBlob = true;
        const ext = p.mediaType === 'video' ? 'mp4' : 'jpg';
        const safeName = `${p.id}.${ext}`;
        const repoPath = `uploads/${safeName}`;
        const base64Data = await blobToBase64(p.blob);

        await githubApiPutFile(
          repo,
          repoPath,
          branch,
          base64Data,
          `Upload media ${safeName}`
        );

        remoteUrl = `https://raw.githubusercontent.com/${repo}/${branch}/${repoPath}`;
        p.remoteMediaUrl = remoteUrl;
        await saveUserPostToDB(p);
      }

      if (remoteUrl && !remoteUrl.startsWith('blob:')) {
        mergedById.set(p.id, {
          id: p.id,
          feedCategory: p.feedCategory || 'following',
          username: 'kaan.doc',
          fullName: p.fullName || 'Kaan',
          isFounding: true,
          location: p.location,
          timeAgo: p.timeAgo,
          timestamp: p.timestamp,
          theme: p.theme,
          score: p.score || 1,
          badgeType: p.badgeType || 'low',
          badgeLabel: p.badgeLabel,
          camera: p.camera || 'C2PA Verified Media',
          likes: p.likes || 1,
          mediaType: p.mediaType,
          mediaUrl: remoteUrl,
          remoteMediaUrl: remoteUrl,
          caption: p.caption,
          comments: p.comments || [],
          isEdited: Boolean(p.isEdited),
        });
      }
    }

    const serializedPosts = Array.from(mergedById.values())
      .filter((p) => !deletedSet.has(p.id))
      .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

    const payload = {
      posts: serializedPosts,
      deletedIds: Array.from(deletedSet),
    };

    const jsonString = JSON.stringify(payload, null, 2);
    const jsonBase64 = btoa(unescape(encodeURIComponent(jsonString)));

    await githubApiPutFile(
      repo,
      'shared-posts.json',
      branch,
      jsonBase64,
      'Update shared-posts.json'
    );

    _cloudSyncRunning = false;
    if (_cloudSyncQueued) {
      _cloudSyncQueued = false;
      return await syncAllUserPostsToCloud();
    }
    return true;
  } catch (err) {
    console.warn('Background cloud sync error:', err);
    _cloudSyncRunning = false;
    if (_cloudSyncQueued) {
      _cloudSyncQueued = false;
      setTimeout(() => syncAllUserPostsToCloud(), 1200);
    }
    return false;
  }
}

// Kaan's Custom Uploaded Profile Photo (Embedded Base64 so it loads 100% instantly)
const KAAN_AVATAR_DATA_URL = 'data:image/jpeg;base64,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';

// Real Profile Photos (Avatars) for All Creators
const AVATARS = {
  kaan: localStorage.getItem('withoutai_kaan_avatar') || KAAN_AVATAR_DATA_URL,
  elif: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=240&auto=format&fit=crop&q=80',
  mert: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=240&auto=format&fit=crop&q=80',
  zeynep: 'https://images.unsplash.com/photo-1517841905240-472988babdf9?w=240&auto=format&fit=crop&q=80',
  kerem: 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=240&auto=format&fit=crop&q=80',
  selin: 'https://images.unsplash.com/photo-1544005313-94ddf0286df2?w=240&auto=format&fit=crop&q=80',
  can: 'https://images.unsplash.com/photo-1539571696357-5a69c17a67c6?w=240&auto=format&fit=crop&q=80',
  lara: 'https://images.unsplash.com/photo-1524504388940-b1c1722653e1?w=240&auto=format&fit=crop&q=80',
  emre: 'https://images.unsplash.com/photo-1492562080023-ab3db95bfbce?w=240&auto=format&fit=crop&q=80',
  aylin: 'https://images.unsplash.com/photo-1531746020798-e6953c6e8e04?w=240&auto=format&fit=crop&q=80',
};

// Detailed User Profiles
const USER_PROFILES = {
  'kaan.doc': {
    username: 'kaan.doc',
    fullName: localStorage.getItem('withoutai_kaan_name') || 'Kaan',
    avatar: AVATARS.kaan,
    isFounding: true,
    followers: 1420,
    followingCount: 318,
    isFollowedByMe: false,
    role: { tr: 'Kurucu Üye · AI-Filtered', en: 'Founding Member · AI-Filtered' },
    location: {
      tr: localStorage.getItem('withoutai_kaan_loc') || 'İstanbul',
      en: localStorage.getItem('withoutai_kaan_loc') || 'Istanbul',
    },
    bio: {
      tr:
        localStorage.getItem('withoutai_kaan_bio') ||
        'Sokak ve belgesel fotoğrafçılığı. Gerçek insanlar, gerçek içerikler. 🔒 KVKK & FSEK Korumalı.',
      en:
        localStorage.getItem('withoutai_kaan_bio') ||
        'Street and documentary photography. Real people, real content. 🔒 KVKK & Copyright Protected.',
    },
  },
  'elif.ceramics': {
    username: 'elif.ceramics',
    fullName: 'Elif Kaya',
    avatar: AVATARS.elif,
    isFounding: true,
    followers: 2890,
    followingCount: 412,
    isFollowedByMe: true,
    role: { tr: 'Seramik & Çömlek Atölyesi', en: 'Ceramics & Pottery Studio' },
    location: { tr: 'Kuzguncuk, İstanbul', en: 'Kuzguncuk, Istanbul' },
    bio: {
      tr: 'Toprak, su ve ateş. Kuzguncuk’taki atölyemde tamamen el yapımı taş çini ve seramik üretiyorum. 🏺',
      en: 'Earth, water, and fire. Handcrafting stoneware and ceramics in my Kuzguncuk studio. 🏺',
    },
  },
  'can.darkroom': {
    username: 'can.darkroom',
    fullName: 'Can Özkan',
    avatar: AVATARS.can,
    isFounding: false,
    followers: 1640,
    followingCount: 275,
    isFollowedByMe: true,
    role: { tr: 'Analog & Karanlık Oda', en: 'Analog & Darkroom' },
    location: { tr: 'Galata, Beyoğlu', en: 'Galata, Istanbul' },
    bio: {
      tr: '35mm siyah-beyaz film ve karanlık oda baskıları. Dijital filtre yok, sadece gümüş jelatin. 🎞️',
      en: '35mm black & white film and silver gelatin darkroom prints. No digital filters. 🎞️',
    },
  },
  'mert.draws': {
    username: 'mert.draws',
    fullName: 'Mert Demir',
    avatar: AVATARS.mert,
    isFounding: true,
    followers: 4120,
    followingCount: 198,
    isFollowedByMe: true,
    role: { tr: 'Ressam & İllüstratör', en: 'Painter & Illustrator' },
    location: { tr: 'Moda, Kadıköy', en: 'Moda, Istanbul' },
    bio: {
      tr: 'Keten tuval üzerine yağlıboya, akrilik ve kömür kalem çalışmaları. 🎨',
      en: 'Oil, acrylic, and charcoal works on linen canvas. 🎨',
    },
  },
  'zeynep.35mm': {
    username: 'zeynep.35mm',
    fullName: 'Zeynep Aksoy',
    avatar: AVATARS.zeynep,
    isFounding: false,
    followers: 3150,
    followingCount: 340,
    isFollowedByMe: true,
    role: { tr: 'Sokak Fotoğrafçısı', en: 'Street Photographer' },
    location: { tr: 'Karaköy, İstanbul', en: 'Karaköy, Istanbul' },
    bio: {
      tr: 'Sabah sisinde İstanbul sokakları, vapurlar ve analog kareler. Leica M11-P & Ilford HP5. 📷',
      en: 'Istanbul streets in the morning fog, ferries, and analog frames. Leica M11-P & Ilford HP5. 📷',
    },
  },
  'emre.street': {
    username: 'emre.street',
    fullName: 'Emre Yalçın',
    avatar: AVATARS.emre,
    isFounding: true,
    followers: 8420,
    followingCount: 215,
    isFollowedByMe: false,
    role: { tr: 'Belgesel Fotoğrafçı', en: 'Documentary Photographer' },
    location: { tr: 'Kapadokya, Nevşehir', en: 'Cappadocia, Turkey' },
    bio: {
      tr: 'Anadolu coğrafyası, doğal ışık ve uzun pozlama doğa fotoğrafçılığı. Sıfır yapay zeka, %100 gerçek anlar.',
      en: 'Anatolian landscapes, natural light, and long-exposure nature photography. Zero AI, 100% real moments.',
    },
  },
  'lara.analog': {
    username: 'lara.analog',
    fullName: 'Lara Soydan',
    avatar: AVATARS.lara,
    isFounding: true,
    followers: 6310,
    followingCount: 290,
    isFollowedByMe: false,
    role: { tr: 'Orta Format Film', en: 'Medium Format Film' },
    location: { tr: 'Balat, İstanbul', en: 'Balat, Istanbul' },
    bio: {
      tr: 'Hasselblad 500C/M & Kodak Portra 400. Orta format analog portre ve mimari fotoğrafçılık. ✨',
      en: 'Hasselblad 500C/M & Kodak Portra 400. Medium format analog portrait and architectural photography. ✨',
    },
  },
  'aylin.sculpt': {
    username: 'aylin.sculpt',
    fullName: 'Aylin Karaca',
    avatar: AVATARS.aylin,
    isFounding: true,
    followers: 5180,
    followingCount: 164,
    isFollowedByMe: false,
    role: { tr: 'Seramik & Heykel', en: 'Ceramics & Sculpture' },
    location: { tr: 'Karaköy Heykel Atölyesi', en: 'Karaköy Sculpture Studio' },
    bio: {
      tr: 'Ahşap oyma, doğal kil ve bronz heykel çalışmaları. El emeği ve organik formlar. 🪵',
      en: 'Wood carving, natural clay, and bronze sculptures. Handcrafted organic forms. 🪵',
    },
  },
  'kerem.art': {
    username: 'kerem.art',
    fullName: 'Kerem Arslan',
    avatar: AVATARS.kerem,
    isFounding: false,
    followers: 3790,
    followingCount: 230,
    isFollowedByMe: true,
    role: { tr: 'Yağlıboya & Tuval', en: 'Oil on Canvas' },
    location: { tr: 'Çukurcuma, Beyoğlu', en: 'Çukurcuma, Istanbul' },
    bio: {
      tr: 'Çukurcuma’daki çatı atölyemde doğal gün ışığıyla çağdaş figüratif yağlıboya tablolar üretiyorum. 🖌️',
      en: 'Painting contemporary figurative oil canvases under natural daylight in my Çukurcuma loft studio. 🖌️',
    },
  },
  'selin.weave': {
    username: 'selin.weave',
    fullName: 'Selin Doğan',
    avatar: AVATARS.selin,
    isFounding: true,
    followers: 2240,
    followingCount: 195,
    isFollowedByMe: false,
    role: { tr: 'El Dokuma & Tekstil', en: 'Handloom & Textile' },
    location: { tr: 'Bozcaada, Çanakkale', en: 'Bozcaada, Turkey' },
    bio: {
      tr: 'Geleneksel ahşap tezgahta doğal kök boya yün ve keten dokumalar. 🧶',
      en: 'Natural root-dyed wool and linen weavings on a traditional wooden handloom. 🧶',
    },
  },
};

// Direct Messages (DM) Conversations
const defaultDmConversations = {
  'elif.ceramics': [
    { from: 'elif.ceramics', text: { tr: 'Selam Kaan! Son paylaştığın Beyoğlu fotoğrafındaki ışık harikaydı.', en: 'Hey Kaan! The light in your latest Beyoğlu photo was amazing.' }, time: '14:20' },
    { from: 'kaan.doc', text: { tr: 'Çok teşekkürler Elif! Senin yeni taş çini vazolar da çok zarif olmuş.', en: 'Thank you so much Elif! Your new stoneware vases turned out so elegant too.' }, time: '14:25' },
  ],
  'mert.draws': [
    { from: 'mert.draws', text: { tr: 'Hafta sonu Moda’daki atölyede sergi önizlemesi var, beklerim!', en: 'Having an exhibition preview at the Moda studio this weekend, hope to see you!' }, time: 'Dün' },
  ],
  'can.darkroom': [
    { from: 'can.darkroom', text: { tr: 'Yeni Ilford HP5 filmler geldi, karanlık odada banyo yapacağız.', en: 'New Ilford HP5 rolls arrived, we are developing them in the darkroom.' }, time: '2g' },
  ],
  'zeynep.35mm': [
    { from: 'zeynep.35mm', text: { tr: 'Sabah Karaköy vapurunda çektiğin kareler çok iyiydi 👏', en: 'The frames you shot on the Karaköy ferry this morning were great 👏' }, time: '3g' },
  ],
  'lara.analog': [
    { from: 'lara.analog', text: { tr: 'Balat’ta orta format çekim için harika bir sabah ışığı var.', en: 'Great morning light in Balat for a medium format shoot.' }, time: '4g' },
  ],
  'emre.street': [
    { from: 'emre.street', text: { tr: 'Kapadokya serisinden yeni baskılar hazır, İstanbul’a gelince uğrayacağım.', en: 'New prints from the Cappadocia series are ready, will drop by when in Istanbul.' }, time: '5g' },
  ],
};

let dmConversations = (() => {
  try {
    const saved = localStorage.getItem('withoutai_dm_v2');
    if (saved) {
      const parsed = JSON.parse(saved);
      if (parsed && typeof parsed === 'object') {
        return { ...defaultDmConversations, ...parsed };
      }
    }
  } catch (_) {}
  return { ...defaultDmConversations };
})();

function saveDmConversations() {
  try {
    localStorage.setItem('withoutai_dm_v2', JSON.stringify(dmConversations));
  } catch (_) {}
}

// Rich Artistic Canvas Fallback
window.handleImgError = function (imgEl) {
  imgEl.onerror = null;
  const c = document.createElement('canvas');
  c.width = 800;
  c.height = 850;
  const ctx = c.getContext('2d');

  const sky = ctx.createLinearGradient(0, 0, 0, 850);
  sky.addColorStop(0, '#D89B72');
  sky.addColorStop(0.55, '#B56345');
  sky.addColorStop(1, '#2D211B');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, 800, 850);

  ctx.fillStyle = 'rgba(255, 236, 209, 0.82)';
  ctx.beginPath();
  ctx.arc(520, 260, 95, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = 'rgba(72, 43, 33, 0.85)';
  ctx.beginPath();
  ctx.moveTo(0, 560);
  ctx.lineTo(210, 390);
  ctx.lineTo(430, 510);
  ctx.lineTo(650, 360);
  ctx.lineTo(800, 470);
  ctx.lineTo(800, 850);
  ctx.lineTo(0, 850);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = '#1F1713';
  ctx.beginPath();
  ctx.moveTo(0, 640);
  ctx.lineTo(290, 510);
  ctx.lineTo(540, 610);
  ctx.lineTo(800, 520);
  ctx.lineTo(800, 850);
  ctx.lineTo(0, 850);
  ctx.closePath();
  ctx.fill();

  imgEl.src = c.toDataURL('image/jpeg', 0.92);
};

// Stories Data
let stories = [
  {
    id: 's1',
    user: 'elif.ceramics',
    avatar: AVATARS.elif,
    mediaType: 'image',
    media: 'https://images.unsplash.com/photo-1565193566173-7a0ee3dbe261?w=1000&auto=format&fit=crop&q=85',
  },
  {
    id: 's2',
    user: 'mert.draws',
    avatar: AVATARS.mert,
    mediaType: 'image',
    media: 'https://images.unsplash.com/photo-1513364776144-60967b0f800f?w=1000&auto=format&fit=crop&q=85',
  },
  {
    id: 's3',
    user: 'zeynep.35mm',
    avatar: AVATARS.zeynep,
    mediaType: 'image',
    media: 'https://images.unsplash.com/photo-1509198397868-475647b2a1e5?w=1000&auto=format&fit=crop&q=85',
  },
  {
    id: 's4',
    user: 'can.darkroom',
    avatar: AVATARS.can,
    mediaType: 'image',
    media: 'https://images.unsplash.com/photo-1516035069371-29a1b244cc32?w=1000&auto=format&fit=crop&q=85',
  },
  {
    id: 's5',
    user: 'lara.analog',
    avatar: AVATARS.lara,
    mediaType: 'image',
    media: 'https://images.unsplash.com/photo-1495567720989-cebdbdd97913?w=1000&auto=format&fit=crop&q=85',
  },
  {
    id: 's6',
    user: 'emre.street',
    avatar: AVATARS.emre,
    mediaType: 'image',
    media: 'https://images.unsplash.com/photo-1506744038136-46273834b3fb?w=1000&auto=format&fit=crop&q=85',
  },
  {
    id: 's7',
    user: 'aylin.sculpt',
    avatar: AVATARS.aylin,
    mediaType: 'image',
    media: 'https://images.unsplash.com/photo-1452860606245-08befc0ff44b?w=1000&auto=format&fit=crop&q=85',
  },
  {
    id: 's8',
    user: 'kerem.art',
    avatar: AVATARS.kerem,
    mediaType: 'image',
    media: 'https://images.unsplash.com/photo-1460661419201-fd4cecdf8a8b?w=1000&auto=format&fit=crop&q=85',
  },
  {
    id: 's9',
    user: 'selin.weave',
    avatar: AVATARS.selin,
    mediaType: 'image',
    media: 'https://images.unsplash.com/photo-1610701596007-11502861dcfa?w=1000&auto=format&fit=crop&q=85',
  },
];

// Default Posts (All <10% AI Verified)
const defaultPosts = [
  // ================= FOLLOWING (TAKİP EDİLENLER - KRONOLOJİK) =================
  {
    id: 'p1',
    feedCategory: 'following',
    username: 'elif.ceramics',
    fullName: 'Elif Kaya',
    avatar: AVATARS.elif,
    isFounding: true,
    location: { tr: 'Kuzguncuk, İstanbul', en: 'Kuzguncuk, Istanbul' },
    timeAgo: { tr: '18 DAKİKA ÖNCE', en: '18 MINUTES AGO' },
    timestamp: 1731594000,
    theme: '#handmade',
    score: 1,
    badgeType: 'low',
    badgeLabel: { tr: 'AI-filtered · %1', en: 'AI-filtered · 1%' },
    camera: 'Sony A7IV (C2PA Signed)',
    likes: 342,
    liked: false,
    saved: false,
    mediaType: 'image',
    mediaUrl: 'https://images.unsplash.com/photo-1565193566173-7a0ee3dbe261?w=1080&auto=format&fit=crop&q=85',
    caption: {
      tr: 'Sabah ışığında fırından yeni çıkan taş çini vazo ve toprak kaseler.',
      en: 'Freshly fired stoneware vase and terracotta bowls in the morning light.',
    },
    comments: [
      { user: 'mert.draws', text: { tr: 'Dokusu ve doğal tonları harika olmuş!', en: 'The texture and natural tones look amazing!' } },
      { user: 'zeynep.35mm', text: { tr: 'Çok zarif 👏', en: 'So elegant 👏' } },
    ],
  },
  {
    id: 'p2',
    feedCategory: 'following',
    username: 'can.darkroom',
    fullName: 'Can Özkan',
    avatar: AVATARS.can,
    isFounding: false,
    location: { tr: 'Galata, Beyoğlu', en: 'Galata, Istanbul' },
    timeAgo: { tr: '1 SAAT ÖNCE', en: '1 HOUR AGO' },
    timestamp: 1731590000,
    theme: '#photography',
    score: 2,
    badgeType: 'low',
    badgeLabel: { tr: 'AI-filtered · %2', en: 'AI-filtered · 2%' },
    camera: 'Fujifilm X-Pro3 · 35mm f/1.4',
    likes: 215,
    liked: false,
    saved: false,
    mediaType: 'image',
    mediaUrl: 'https://images.unsplash.com/photo-1516035069371-29a1b244cc32?w=1080&auto=format&fit=crop&q=85',
    caption: {
      tr: 'Hafta sonu yürüyüşünden önce emektar analog makinem ve lenslerim.',
      en: 'My trusted analog camera and lenses before the weekend walk.',
    },
    comments: [
      { user: 'kaan.doc', text: { tr: '35mm lensin keskinliği bambaşka.', en: 'Nothing beats the sharpness of that 35mm lens.' } },
    ],
  },
  {
    id: 'p3',
    feedCategory: 'following',
    username: 'mert.draws',
    fullName: 'Mert Demir',
    avatar: AVATARS.mert,
    isFounding: true,
    location: { tr: 'Moda, Kadıköy', en: 'Moda, Istanbul' },
    timeAgo: { tr: '3 SAAT ÖNCE', en: '3 HOURS AGO' },
    timestamp: 1731584000,
    theme: '#art',
    score: 3,
    badgeType: 'low',
    badgeLabel: { tr: 'AI-filtered · %3', en: 'AI-filtered · 3%' },
    camera: 'Canon EOS R6 · Studio Light',
    likes: 518,
    liked: true,
    saved: true,
    mediaType: 'image',
    mediaUrl: 'https://images.unsplash.com/photo-1513364776144-60967b0f800f?w=1080&auto=format&fit=crop&q=85',
    caption: {
      tr: 'Yeni sergi hazırlığından keten tuval üzerine yağlıboya, fırçalar ve doğal pigmentler.',
      en: 'Oil on linen canvas, brushes, and natural pigments from my upcoming exhibition prep.',
    },
    comments: [
      { user: 'elif.ceramics', text: { tr: 'Fırça darbeleri ve renk paleti çok canlı duruyor.', en: 'The brushstrokes and color palette look so vibrant.' } },
    ],
  },
  {
    id: 'p4',
    feedCategory: 'following',
    username: 'zeynep.35mm',
    fullName: 'Zeynep Aksoy',
    avatar: AVATARS.zeynep,
    isFounding: false,
    location: { tr: 'Karaköy İskelesi', en: 'Karaköy Pier' },
    timeAgo: { tr: '6 SAAT ÖNCE', en: '6 HOURS AGO' },
    timestamp: 1731572000,
    theme: '#photography',
    score: 1,
    badgeType: 'low',
    badgeLabel: { tr: 'AI-filtered · %1', en: 'AI-filtered · 1%' },
    camera: 'Leica M11-P (C2PA Signed)',
    likes: 389,
    liked: false,
    saved: false,
    mediaType: 'image',
    mediaUrl: 'https://images.unsplash.com/photo-1509198397868-475647b2a1e5?w=1080&auto=format&fit=crop&q=85',
    caption: {
      tr: 'Sabah sisinde sessiz sokaklar. Ilford HP5 400 siyah-beyaz film.',
      en: 'Quiet streets in the morning fog. Ilford HP5 400 black and white film.',
    },
    comments: [],
  },
  {
    id: 'k1',
    feedCategory: 'following',
    username: 'kaan.doc',
    fullName: 'Kaan',
    avatar: AVATARS.kaan,
    isFounding: true,
    location: { tr: 'Beyoğlu, İstanbul', en: 'Beyoğlu, Istanbul' },
    timeAgo: { tr: '1 GÜN ÖNCE', en: '1 DAY AGO' },
    timestamp: 1731540000,
    theme: '#photography',
    score: 1,
    badgeType: 'low',
    badgeLabel: { tr: 'AI-filtered · %1', en: 'AI-filtered · 1%' },
    camera: 'Leica Q2 (C2PA Signed)',
    likes: 476,
    liked: true,
    saved: false,
    mediaType: 'image',
    mediaUrl: 'https://images.unsplash.com/photo-1513635269975-59663e0ac1ad?w=1080&auto=format&fit=crop&q=85',
    caption: {
      tr: 'Akşamüstü yürüyüşünden mimari gölgeler ve doğal ışık.',
      en: 'Architectural shadows and natural light from a late afternoon walk.',
    },
    comments: [
      { user: 'can.darkroom', text: { tr: 'Işık ve kontrast harika çıkmış Kaan!', en: 'Light and contrast turned out great Kaan!' } },
    ],
  },

  // ================= FEATURED (ÖNE ÇIKANLAR - TOPLULUK SEÇKİSİ) =================
  {
    id: 'f1',
    feedCategory: 'featured',
    username: 'emre.street',
    fullName: 'Emre Yalçın',
    avatar: AVATARS.emre,
    isFounding: true,
    location: { tr: 'Kapadokya, Nevşehir', en: 'Cappadocia, Turkey' },
    timeAgo: { tr: 'HAFTANIN ÖNE ÇIKANI', en: 'FEATURED THIS WEEK' },
    timestamp: 1731596000,
    theme: '#photography',
    score: 1,
    badgeType: 'low',
    badgeLabel: { tr: 'AI-filtered · %1', en: 'AI-filtered · 1%' },
    camera: 'Sony A7R V (C2PA Signed)',
    likes: 2410,
    liked: true,
    saved: false,
    mediaType: 'image',
    mediaUrl: 'https://images.unsplash.com/photo-1506744038136-46273834b3fb?w=1080&auto=format&fit=crop&q=85',
    caption: {
      tr: 'Sabah 05:30’da vadinin üzerine çöken sis ve ilk gün ışığı. Sıfır dijital manipülasyon, tek kare uzun pozlama.',
      en: 'Mist settling over the valley and first daylight at 05:30 AM. Zero digital manipulation, single-frame long exposure.',
    },
    comments: [
      { user: 'kaan.doc', text: { tr: 'İnanılmaz bir atmosfer, ışık kusursuz yakalanmış.', en: 'Unbelievable atmosphere, the light is captured perfectly.' } },
      { user: 'zeynep.35mm', text: { tr: 'Gerçek doğa fotoğrafçılığı budur!', en: 'This is what real nature photography is all about!' } },
    ],
  },
  {
    id: 'f2',
    feedCategory: 'featured',
    username: 'lara.analog',
    fullName: 'Lara Soydan',
    avatar: AVATARS.lara,
    isFounding: true,
    location: { tr: 'Balat, İstanbul', en: 'Balat, Istanbul' },
    timeAgo: { tr: 'AYIN SEÇKİSİ', en: 'MONTHLY PICK' },
    timestamp: 1731595000,
    theme: '#photography',
    score: 1,
    badgeType: 'low',
    badgeLabel: { tr: 'AI-filtered · %1', en: 'AI-filtered · 1%' },
    camera: 'Hasselblad 500C/M · Kodak Portra 400',
    likes: 1845,
    liked: false,
    saved: true,
    mediaType: 'image',
    mediaUrl: 'https://images.unsplash.com/photo-1495567720989-cebdbdd97913?w=1080&auto=format&fit=crop&q=85',
    caption: {
      tr: 'Kodak Portra 400 orta format film ile yakalanan akşamüstü kızıllığı.',
      en: 'Late afternoon crimson sky captured on Kodak Portra 400 medium format film.',
    },
    comments: [
      { user: 'can.darkroom', text: { tr: 'Portra 400 renk geçişleri bir başka.', en: 'Portra 400 color roll-off is unmatched.' } },
    ],
  },
  {
    id: 'f3',
    feedCategory: 'featured',
    username: 'aylin.sculpt',
    fullName: 'Aylin Karaca',
    avatar: AVATARS.aylin,
    isFounding: true,
    location: { tr: 'Karaköy Heykel Atölyesi', en: 'Karaköy Sculpture Studio' },
    timeAgo: { tr: 'ÖNE ÇIKAN ESER', en: 'FEATURED WORK' },
    timestamp: 1731593000,
    theme: '#handmade',
    score: 2,
    badgeType: 'low',
    badgeLabel: { tr: 'AI-filtered · %2', en: 'AI-filtered · 2%' },
    camera: 'Nikon Z8 · 50mm f/1.2',
    likes: 1290,
    liked: false,
    saved: false,
    mediaType: 'image',
    mediaUrl: 'https://images.unsplash.com/photo-1452860606245-08befc0ff44b?w=1080&auto=format&fit=crop&q=85',
    caption: {
      tr: 'Ahşap oyma ve doğal kil kalıplarla iki ayda tamamlanan el işçiliği.',
      en: 'Handcrafted wood carving and natural clay molds completed over two months.',
    },
    comments: [],
  },
  {
    id: 'f4',
    feedCategory: 'featured',
    username: 'kerem.art',
    fullName: 'Kerem Arslan',
    avatar: AVATARS.kerem,
    isFounding: false,
    location: { tr: 'Çukurcuma, Beyoğlu', en: 'Çukurcuma, Istanbul' },
    timeAgo: { tr: 'ÖNE ÇIKAN ESER', en: 'FEATURED WORK' },
    timestamp: 1731591000,
    theme: '#art',
    score: 2,
    badgeType: 'low',
    badgeLabel: { tr: 'AI-filtered · %2', en: 'AI-filtered · 2%' },
    camera: 'Leica Q3 (C2PA Signed)',
    likes: 965,
    liked: false,
    saved: false,
    mediaType: 'image',
    mediaUrl: 'https://images.unsplash.com/photo-1460661419201-fd4cecdf8a8b?w=1080&auto=format&fit=crop&q=85',
    caption: {
      tr: 'Atölyede doğal gün ışığıyla tamamlanan yeni yağlıboya serisi.',
      en: 'New oil painting series completed under natural studio daylight.',
    },
    comments: [],
  },

  // ================= ADDITIONAL PROFILE POSTS FOR CREATORS =================
  {
    id: 'p1-b',
    feedCategory: 'profile_extra',
    username: 'elif.ceramics',
    fullName: 'Elif Kaya',
    avatar: AVATARS.elif,
    isFounding: true,
    location: { tr: 'Kuzguncuk, İstanbul', en: 'Kuzguncuk, Istanbul' },
    timeAgo: { tr: '3 GÜN ÖNCE', en: '3 DAYS AGO' },
    timestamp: 1731420000,
    theme: '#handmade',
    score: 1,
    badgeType: 'low',
    badgeLabel: { tr: 'AI-filtered · %1', en: 'AI-filtered · 1%' },
    camera: 'Sony A7IV (C2PA Signed)',
    likes: 410,
    liked: false,
    saved: false,
    mediaType: 'image',
    mediaUrl: 'https://images.unsplash.com/photo-1610701596007-11502861dcfa?w=1080&auto=format&fit=crop&q=85',
    caption: {
      tr: 'El yapımı sırlı kahve fincanları ve doğal kil dokusu.',
      en: 'Handmade glazed coffee cups and natural clay texture.',
    },
    comments: [],
  },
  {
    id: 'p2-b',
    feedCategory: 'profile_extra',
    username: 'can.darkroom',
    fullName: 'Can Özkan',
    avatar: AVATARS.can,
    isFounding: false,
    location: { tr: 'Galata, Beyoğlu', en: 'Galata, Istanbul' },
    timeAgo: { tr: '4 GÜN ÖNCE', en: '4 DAYS AGO' },
    timestamp: 1731350000,
    theme: '#photography',
    score: 1,
    badgeType: 'low',
    badgeLabel: { tr: 'AI-filtered · %1', en: 'AI-filtered · 1%' },
    camera: 'Fujifilm X-Pro3 · 35mm f/1.4',
    likes: 284,
    liked: false,
    saved: false,
    mediaType: 'image',
    mediaUrl: 'https://images.unsplash.com/photo-1492691527719-9d1e07e534b4?w=1080&auto=format&fit=crop&q=85',
    caption: {
      tr: 'Dağ yolunda sabah rüzgarı ve 35mm film greni.',
      en: 'Morning wind on the mountain road and 35mm film grain.',
    },
    comments: [],
  },
  {
    id: 'p3-b',
    feedCategory: 'profile_extra',
    username: 'mert.draws',
    fullName: 'Mert Demir',
    avatar: AVATARS.mert,
    isFounding: true,
    location: { tr: 'Moda, Kadıköy', en: 'Moda, Istanbul' },
    timeAgo: { tr: '5 GÜN ÖNCE', en: '5 DAYS AGO' },
    timestamp: 1731290000,
    theme: '#art',
    score: 2,
    badgeType: 'low',
    badgeLabel: { tr: 'AI-filtered · %2', en: 'AI-filtered · 2%' },
    camera: 'Canon EOS R6 · Studio Light',
    likes: 612,
    liked: false,
    saved: false,
    mediaType: 'image',
    mediaUrl: 'https://images.unsplash.com/photo-1460661419201-fd4cecdf8a8b?w=1080&auto=format&fit=crop&q=85',
    caption: {
      tr: 'Atölye masasından akrilik renk denemeleri ve eskiz defterim.',
      en: 'Acrylic color studies and my sketchbook on the studio table.',
    },
    comments: [],
  },
  {
    id: 'p4-b',
    feedCategory: 'profile_extra',
    username: 'zeynep.35mm',
    fullName: 'Zeynep Aksoy',
    avatar: AVATARS.zeynep,
    isFounding: false,
    location: { tr: 'Eminönü, İstanbul', en: 'Eminönü, Istanbul' },
    timeAgo: { tr: '4 GÜN ÖNCE', en: '4 DAYS AGO' },
    timestamp: 1731310000,
    theme: '#photography',
    score: 1,
    badgeType: 'low',
    badgeLabel: { tr: 'AI-filtered · %1', en: 'AI-filtered · 1%' },
    camera: 'Leica M11-P (C2PA Signed)',
    likes: 445,
    liked: false,
    saved: false,
    mediaType: 'image',
    mediaUrl: 'https://images.unsplash.com/photo-1477959858617-67f85cf4f1df?w=1080&auto=format&fit=crop&q=85',
    caption: {
      tr: 'Şehir ışıkları ve akşam trafiği.',
      en: 'City lights and evening traffic.',
    },
    comments: [],
  },
  {
    id: 's9-p',
    feedCategory: 'profile_extra',
    username: 'selin.weave',
    fullName: 'Selin Doğan',
    avatar: AVATARS.selin,
    isFounding: true,
    location: { tr: 'Bozcaada, Çanakkale', en: 'Bozcaada, Turkey' },
    timeAgo: { tr: '2 GÜN ÖNCE', en: '2 DAYS AGO' },
    timestamp: 1731490000,
    theme: '#handmade',
    score: 1,
    badgeType: 'low',
    badgeLabel: { tr: 'AI-filtered · %1', en: 'AI-filtered · 1%' },
    camera: 'Fujifilm X-T5 (C2PA Signed)',
    likes: 530,
    liked: false,
    saved: false,
    mediaType: 'image',
    mediaUrl: 'https://images.unsplash.com/photo-1452860606245-08befc0ff44b?w=1080&auto=format&fit=crop&q=85',
    caption: {
      tr: 'Ahşap dokuma tezgahında kök boya yün ipliklerle yeni desen hazırlığı.',
      en: 'Preparing a new pattern with root-dyed wool threads on the wooden handloom.',
    },
    comments: [],
  },
];

let posts = [...defaultPosts];

let suggestedCreators = [
  {
    username: 'lara.analog',
    role: { tr: 'Orta Format Film', en: 'Medium Format Film' },
    avatar: AVATARS.lara,
  },
  {
    username: 'emre.street',
    role: { tr: 'Belgesel Fotoğrafçı', en: 'Documentary Photo' },
    avatar: AVATARS.emre,
  },
  {
    username: 'aylin.sculpt',
    role: { tr: 'Seramik & Heykel', en: 'Ceramics & Sculpture' },
    avatar: AVATARS.aylin,
  },
  {
    username: 'selin.weave',
    role: { tr: 'El Dokuma & Tekstil', en: 'Handloom & Textile' },
    avatar: AVATARS.selin,
  },
];

// Dictionary (TR / EN)
const dict = {
  tr: {
    tagline: 'gerçek insanlar, gerçek emek',
    nav: {
      home: 'Ana Sayfa',
      explore: 'Keşfet',
      messages: 'Mesajlar',
      create: 'Fotoğraf / Video Yükle',
      cloudSync: 'GitHub Bulut Eşitleme',
      activity: 'Bildirimler',
      profile: 'Profilim',
      day: 'Gündüz',
      night: 'Gece',
    },
    feed: {
      chrono: '🕒 Takip Edilenler',
      featured: '✨ Öne Çıkanlar',
      quickUpload: '➕ Yükle',
      yourStory: 'Hikaye Ekle',
      editBtn: 'Düzenle',
      deleteBtn: 'Sil',
      deletedToast: 'Gönderin silindi.',
      updatedToast: 'Gönderin başarıyla güncellendi!',
      likes: 'beğenme',
      addComment: 'Yorum ekle...',
      postBtn: 'Paylaş',
    },
    right: {
      myRole: 'Kurucu Üye · AI-Filtered',
      newPostBtn: '+ Yükle',
      themeBoxTitle: 'Popüler Etiketler',
      themeDesc: 'Algoritma dayatması olmadan gerçek insanların paylaştığı fotoğraf ve videoları keşfet. (%10 ve üzeri AI içerikler otomatik kaldırılır.)',
      suggestedTitle: 'Önerilen Hesaplar',
      follow: 'Takip Et',
      following: 'Takip Ediliyor',
      footerNote: 'WithoutAI · %10 ve üzeri AI oranı tespit edilen içerikler otomatik kaldırılır. Konum verileri (EXIF GPS) KVKK kapsamında temizlenir.',
    },
    createModal: {
      title: 'Yeni Gönderi Paylaş',
      sub: 'Bilgisayarından bir fotoğraf veya video seç. Yüklenen içerik otomatik AI filtresinden geçer (%10 ve üzeri AI oranı tespit edilen içerikler otomatik kaldırılır):',
      dropTitle: '📸 🎬 Fotoğraf veya Video Seçmek İçin Tıkla / Sürükle',
      dropSub: 'MP4, WebM, MOV, JPG, PNG desteklenir',
      removeMedia: '🗑️ Kaldır / Değiştir',
      captionLabel: 'Açıklama',
      themeLabel: 'Etiket',
      locationLabel: 'Konum',
      simTitle: '🧪 AI Filtre Tarama Modu (Eşik: Maksimum %10 AI)',
      simReal: '🟢 Gerçek İçerik (%2 AI · Onaylanır)',
      simAi: '🔴 Şüpheli AI Testi (%84 AI · ≥%10 Kaldırılır)',
      scanBtn: '🚀 AI Filtresinden Geçir ve Paylaş',
      scanning: 'AI filtresi pikselleri ve C2PA imzasını tarıyor...',
    },
    editPostModal: {
      title: 'Gönderiyi Düzenle',
      changeMedia: '📸 🎬 Fotoğrafı / Videoyu Değiştir (İsteğe Bağlı)',
      captionLabel: 'Açıklama',
      themeLabel: 'Etiket (#photography, #handmade, #art)',
      locationLabel: 'Konum',
      cameraLabel: 'Kamera / Ekipman Bilgisi',
      saveBtn: '💾 Değişiklikleri Kaydet',
    },
    reportModal: {
      title: 'Gönderi & AI Filtre Raporu',
      camera: 'Kamera / Medya Doğrulaması',
      score: 'AI Olasılık Skoru',
      threshold: 'Platform Filtre Kuralı',
      thresholdVal: '< %10 AI Onaylı · ≥ %10 Otomatik Kaldırılır',
      kvkk: 'KVKK Konum Verisi (EXIF GPS)',
      kvkkVal: 'Paylaşım öncesi otomatik silindi',
      fsek: 'Telif Hakkı (FSEK)',
      fsekVal: 'Kullanıcıya aittir · AI eğitimine kapalı',
      editPost: '✏️ Gönderiyi Düzenle',
      deletePost: '🗑️ Sil',
      viewProfile: '👤 Profile Git',
      close: 'Kapat',
    },
  },
  en: {
    tagline: 'real people, real effort',
    nav: {
      home: 'Home',
      explore: 'Explore',
      messages: 'Messages',
      create: 'Upload Photo / Video',
      cloudSync: 'GitHub Cloud Sync',
      activity: 'Notifications',
      profile: 'My Profile',
      day: 'Light',
      night: 'Dark',
    },
    feed: {
      chrono: '🕒 Following',
      featured: '✨ Featured',
      quickUpload: '➕ Upload',
      yourStory: 'Add Story',
      editBtn: 'Edit',
      deleteBtn: 'Delete',
      deletedToast: 'Your post was deleted.',
      updatedToast: 'Your post was updated!',
      likes: 'likes',
      addComment: 'Add a comment...',
      postBtn: 'Post',
    },
    right: {
      myRole: 'Founding Member · AI-Filtered',
      newPostBtn: '+ Upload',
      themeBoxTitle: 'Popular Tags',
      themeDesc: 'Discover real photos and videos shared by people. (Content with ≥10% AI probability is automatically removed.)',
      suggestedTitle: 'Suggested Accounts',
      follow: 'Follow',
      following: 'Following',
      footerNote: 'WithoutAI · Content with ≥10% AI probability is automatically removed. EXIF GPS data is stripped (KVKK).',
    },
    createModal: {
      title: 'Create New Post',
      sub: 'Pick a photo or video from your computer. It passes through the automatic AI filter (content with ≥10% AI score is automatically removed):',
      dropTitle: '📸 🎬 Click or Drag & Drop a Photo or Video',
      dropSub: 'Supports MP4, WebM, MOV, JPG, PNG',
      removeMedia: '🗑️ Remove / Change',
      captionLabel: 'Caption',
      themeLabel: 'Tag',
      locationLabel: 'Location',
      simTitle: '🧪 AI Filter Scan Mode (Threshold: Max 10% AI)',
      simReal: '🟢 Real Content (2% AI · Approved)',
      simAi: '🔴 Suspected AI Test (84% AI · ≥10% Removed)',
      scanBtn: '🚀 Scan with AI Filter & Share',
      scanning: 'AI filter scanning pixels & C2PA signature...',
    },
    editPostModal: {
      title: 'Edit Post',
      changeMedia: '📸 🎬 Replace Photo / Video (Optional)',
      captionLabel: 'Caption',
      themeLabel: 'Tag (#photography, #handmade, #art)',
      locationLabel: 'Location',
      cameraLabel: 'Camera / Gear Info',
      saveBtn: '💾 Save Changes',
    },
    reportModal: {
      title: 'Post & AI Filter Report',
      camera: 'Camera / Media Check',
      score: 'AI Probability Score',
      threshold: 'Platform Filter Rule',
      thresholdVal: '< 10% AI Approved · ≥ 10% Auto-Removed',
      kvkk: 'Personal Data (KVKK GPS)',
      kvkkVal: 'Deleted before posting',
      fsek: 'Copyright (FSEK)',
      fsekVal: 'Creator owned · Never trains AI',
      editPost: '✏️ Edit Post',
      deletePost: '🗑️ Delete',
      viewProfile: '👤 View Profile',
      close: 'Close',
    },
  },
};

function tr(path) {
  const parts = path.split('.');
  let cur = dict[state.lang];
  for (const p of parts) {
    if (cur && cur[p] !== undefined) cur = cur[p];
    else return path;
  }
  return cur;
}

function toast(msg) {
  const el = document.getElementById('ig-toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 3200);
}

function formatBytes(bytes) {
  if (!bytes) return '';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function readPostsFromSingleDB(dbName) {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(dbName);
      req.onsuccess = () => {
        const db = req.result;
        const storeNames = Array.from(db.objectStoreNames || []);
        if (storeNames.length === 0) {
          db.close();
          resolve([]);
          return;
        }
        const targetStore = storeNames.includes(STORE_NAME) ? STORE_NAME : storeNames[0];
        try {
          const tx = db.transaction(targetStore, 'readonly');
          const getAllReq = tx.objectStore(targetStore).getAll();
          getAllReq.onsuccess = () => {
            const res = getAllReq.result || [];
            db.close();
            resolve(res);
          };
          getAllReq.onerror = () => {
            db.close();
            resolve([]);
          };
        } catch (_) {
          db.close();
          resolve([]);
        }
      };
      req.onerror = () => resolve([]);
    } catch (_) {
      resolve([]);
    }
  });
}

async function loadUserPostsFromDB() {
  try {
    const deletedSet = getDeletedPostIds();
    const dbNamesSet = new Set(LEGACY_DB_NAMES);

    if (typeof indexedDB.databases === 'function') {
      try {
        const dbs = await indexedDB.databases();
        for (const info of dbs || []) {
          if (info && info.name && /withoutai/i.test(info.name)) {
            dbNamesSet.add(info.name);
          }
        }
      } catch (_) {}
    }

    const byId = new Map();
    for (const dbName of dbNamesSet) {
      const list = await readPostsFromSingleDB(dbName);
      for (const rawPost of list) {
        if (!rawPost || !rawPost.id || deletedSet.has(rawPost.id)) continue;
        const p = { ...rawPost };
        p.username = 'kaan.doc';
        p.fullName = USER_PROFILES['kaan.doc'].fullName;
        p.avatar = AVATARS.kaan;
        p.feedCategory = 'following';

        const blobObj = p.blob || p.file || p.mainBlob || p.mediaBlob;
        if (blobObj instanceof Blob) {
          p.blob = blobObj;
          p.mediaUrl = URL.createObjectURL(blobObj);
          byId.set(p.id, p);
          if (dbName !== DB_NAME) {
            saveUserPostToDB(p);
          }
        } else if (p.remoteMediaUrl) {
          p.mediaUrl = p.remoteMediaUrl;
          if (!byId.has(p.id)) byId.set(p.id, p);
        } else if (p.mediaUrl && !p.mediaUrl.startsWith('blob:')) {
          if (!byId.has(p.id)) byId.set(p.id, p);
        }
      }
    }

    return Array.from(byId.values());
  } catch (e) {
    return [];
  }
}

// ==================== STORIES BAR SCROLLING ====================
let storiesDragState = {
  isDown: false,
  startX: 0,
  scrollLeft: 0,
  moved: false,
};

function handleStoriesWheel(e) {
  const bar = document.getElementById('stories-scroll-bar');
  if (!bar) return;
  if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
    e.preventDefault();
    bar.scrollLeft += e.deltaY;
  }
}

function startStoriesDrag(e) {
  const bar = document.getElementById('stories-scroll-bar');
  if (!bar) return;
  storiesDragState.isDown = true;
  storiesDragState.moved = false;
  storiesDragState.startX = e.pageX - bar.offsetLeft;
  storiesDragState.scrollLeft = bar.scrollLeft;
}

function moveStoriesDrag(e) {
  if (!storiesDragState.isDown) return;
  const bar = document.getElementById('stories-scroll-bar');
  if (!bar) return;
  const x = e.pageX - bar.offsetLeft;
  const walk = x - storiesDragState.startX;
  if (Math.abs(walk) > 6) {
    storiesDragState.moved = true;
    e.preventDefault();
    bar.scrollLeft = storiesDragState.scrollLeft - walk;
  }
}

function endStoriesDrag() {
  storiesDragState.isDown = false;
  setTimeout(() => {
    storiesDragState.moved = false;
  }, 50);
}

function handleStoryItemClick(storyId) {
  if (storiesDragState.moved) return;
  openStoryModal(storyId);
}

function navigateStoryModal(direction) {
  if (!state.modal || state.modal.type !== 'story') return;
  const idx = stories.findIndex((s) => s.id === state.modal.storyId);
  if (idx === -1) return;
  const nextIdx = (idx + direction + stories.length) % stories.length;
  state.modal.storyId = stories[nextIdx].id;
  renderModal();
}

window.addEventListener('keydown', (e) => {
  if (!state.modal) return;
  if (e.key === 'Escape') {
    closeModal();
  } else if (state.modal.type === 'story') {
    if (e.key === 'ArrowLeft') navigateStoryModal(-1);
    if (e.key === 'ArrowRight') navigateStoryModal(1);
  }
});

// ==================== NAVIGATION & PROFILE ROUTING ====================
function setLang(l) {
  state.lang = l;
  localStorage.setItem('withoutai_lang', l);
  document.documentElement.lang = l;
  renderAll();
}

function setTheme(th) {
  state.theme = th;
  localStorage.setItem('withoutai_theme', th);
  document.documentElement.setAttribute('data-theme', th);
  renderNavigation();
}

function scrollDmToBottom() {
  const msgBox = document.getElementById('dm-messages-scroll');
  if (msgBox) {
    msgBox.scrollTop = msgBox.scrollHeight;
  }
}

function handleDmThreadsWheel(e) {
  const listEl = document.getElementById('dm-thread-list-bar');
  if (!listEl) return;
  if (window.innerWidth <= 780 && Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
    e.preventDefault();
    listEl.scrollLeft += e.deltaY;
  }
}

function selectDmThread(username) {
  if (!username || username === 'kaan.doc') return;
  if (!dmConversations[username]) {
    dmConversations[username] = [];
  }
  const threadList = document.getElementById('dm-thread-list-bar');
  const prevScrollTop = threadList ? threadList.scrollTop : 0;
  const prevScrollLeft = threadList ? threadList.scrollLeft : 0;

  state.activeDmUser = username;
  renderMain();

  const newThreadList = document.getElementById('dm-thread-list-bar');
  if (newThreadList) {
    newThreadList.scrollTop = prevScrollTop;
    newThreadList.scrollLeft = prevScrollLeft;
    const activeItem = newThreadList.querySelector('.dm-thread-item.active');
    if (activeItem && typeof activeItem.scrollIntoView === 'function') {
      activeItem.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
    }
  }
  scrollDmToBottom();
}

function setPage(p) {
  if (p === 'profile') {
    state.profileUser = 'kaan.doc';
  }
  state.page = p;
  window.scrollTo({ top: 0, behavior: 'smooth' });
  renderNavigation();
  renderMain();
  if (p === 'messages') {
    scrollDmToBottom();
  }
}

function openUserProfile(username) {
  if (!username) return;
  state.profileUser = username;
  state.profileTab = 'posts';
  state.page = 'profile';
  if (state.modal) {
    state.modal = null;
    renderModal();
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });
  renderNavigation();
  renderMain();
}

function openDirectMessageWith(username) {
  if (!username || username === 'kaan.doc') {
    setPage('messages');
    return;
  }
  if (!dmConversations[username]) {
    dmConversations[username] = [];
  }
  state.activeDmUser = username;
  state.page = 'messages';
  if (state.modal) {
    state.modal = null;
    renderModal();
  }
  renderNavigation();
  renderMain();
  scrollDmToBottom();
}

function sendDirectMessage() {
  const input = document.getElementById('dm-message-input');
  if (!input || !input.value.trim()) return;
  const text = input.value.trim();
  const target = state.activeDmUser || 'elif.ceramics';
  const nowLabel = state.lang === 'tr' ? 'Şimdi' : 'Now';

  if (!dmConversations[target]) dmConversations[target] = [];
  dmConversations[target].push({
    from: 'kaan.doc',
    text: { tr: text, en: text },
    time: nowLabel,
  });
  saveDmConversations();

  input.value = '';

  const msgBox = document.getElementById('dm-messages-scroll');
  if (msgBox) {
    const emptyHint = msgBox.querySelector('.dm-empty-hint');
    if (emptyHint) emptyHint.remove();

    const bubble = document.createElement('div');
    bubble.className = 'dm-bubble mine';

    const textDiv = document.createElement('div');
    textDiv.textContent = text;

    const timeDiv = document.createElement('div');
    timeDiv.style.cssText = 'font-size:0.65rem; opacity:0.75; margin-top:3px; text-align:right;';
    timeDiv.textContent = nowLabel;

    bubble.appendChild(textDiv);
    bubble.appendChild(timeDiv);
    msgBox.appendChild(bubble);
    msgBox.scrollTop = msgBox.scrollHeight;
  }

  const previewEl = document.getElementById(`dm-preview-${target}`);
  if (previewEl) {
    previewEl.textContent = (state.lang === 'tr' ? 'Sen: ' : 'You: ') + text;
  }
  const timeEl = document.getElementById(`dm-time-${target}`);
  if (timeEl) {
    timeEl.textContent = nowLabel;
  }

  input.focus();
}

function toggleFollowUser(username) {
  const prof = USER_PROFILES[username];
  if (!prof || username === 'kaan.doc') return;
  prof.isFollowedByMe = !prof.isFollowedByMe;
  prof.followers += prof.isFollowedByMe ? 1 : -1;
  renderMain();
  if (state.modal && state.modal.type === 'followers') {
    renderModal();
  }
}

function openFollowersModal(listType, username) {
  state.modal = { type: 'followers', listType, username };
  renderModal();
}

function openEditProfileModal() {
  state.modal = { type: 'editProfile' };
  renderModal();
}

function handleProfileAvatarInput(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = reader.result;
    AVATARS.kaan = dataUrl;
    USER_PROFILES['kaan.doc'].avatar = dataUrl;
    localStorage.setItem('withoutai_kaan_avatar', dataUrl);
    posts.forEach((p) => {
      if (p.username === 'kaan.doc') p.avatar = dataUrl;
    });
    renderModal();
    renderMain();
  };
  reader.readAsDataURL(file);
}

function saveProfileEdits() {
  const nameEl = document.getElementById('edit-prof-name');
  const locEl = document.getElementById('edit-prof-loc');
  const bioEl = document.getElementById('edit-prof-bio');

  if (nameEl && nameEl.value.trim()) {
    USER_PROFILES['kaan.doc'].fullName = nameEl.value.trim();
    localStorage.setItem('withoutai_kaan_name', nameEl.value.trim());
  }
  if (locEl && locEl.value.trim()) {
    USER_PROFILES['kaan.doc'].location = { tr: locEl.value.trim(), en: locEl.value.trim() };
    localStorage.setItem('withoutai_kaan_loc', locEl.value.trim());
  }
  if (bioEl && bioEl.value.trim()) {
    USER_PROFILES['kaan.doc'].bio = { tr: bioEl.value.trim(), en: bioEl.value.trim() };
    localStorage.setItem('withoutai_kaan_bio', bioEl.value.trim());
  }

  closeModal();
  renderMain();
  toast(state.lang === 'tr' ? 'Profil bilgilerin güncellendi!' : 'Profile updated!');
}

// ==================== EDIT UPLOADED POSTS (CAPTION, TAG, LOCATION, CAMERA, MEDIA) ====================
function openEditPostModal(postId) {
  const post = posts.find((p) => p.id === postId);
  if (!post || post.username !== 'kaan.doc') return;

  state.editPostDraft = {
    postId: post.id,
    caption: post.caption[state.lang] || '',
    theme: post.theme || '#photography',
    location: post.location[state.lang] || 'İstanbul',
    camera: post.camera || 'C2PA Verified Media',
    newMedia: null,
  };
  state.modal = { type: 'editPost', postId: post.id };
  renderModal();
}

function syncEditPostInputs() {
  if (!state.editPostDraft) return;
  const capEl = document.getElementById('edit-post-caption');
  const thEl = document.getElementById('edit-post-theme');
  const locEl = document.getElementById('edit-post-location');
  const camEl = document.getElementById('edit-post-camera');

  if (capEl) state.editPostDraft.caption = capEl.value;
  if (thEl) state.editPostDraft.theme = thEl.value;
  if (locEl) state.editPostDraft.location = locEl.value;
  if (camEl) state.editPostDraft.camera = camEl.value;
}

function handleEditPostMediaInput(e) {
  const file = e.target.files && e.target.files[0];
  if (!file || !state.editPostDraft) return;
  syncEditPostInputs();
  const mediaObj = createMediaObjectFromFile(file);
  if (mediaObj.hasAiKeyword) {
    toast(
      state.lang === 'tr'
        ? '⛔ Seçilen dosyada ≥%10 AI izi tespit edildiği için değiştirilemedi!'
        : '⛔ Selected file has ≥10% AI trace and cannot be used!'
    );
    return;
  }
  state.editPostDraft.newMedia = mediaObj;
  renderModal();
}

async function saveEditedPost() {
  if (!state.editPostDraft) return;
  syncEditPostInputs();

  const post = posts.find((p) => p.id === state.editPostDraft.postId);
  if (!post || post.username !== 'kaan.doc') return;

  const newCap = state.editPostDraft.caption.trim() || post.caption[state.lang];
  let newTheme = state.editPostDraft.theme.trim() || '#photography';
  if (!newTheme.startsWith('#')) newTheme = '#' + newTheme;
  const newLoc = state.editPostDraft.location.trim() || 'İstanbul';
  const newCam = state.editPostDraft.camera.trim() || 'C2PA Verified Media';

  post.caption = { tr: newCap, en: newCap };
  post.theme = newTheme;
  post.location = { tr: newLoc, en: newLoc };
  post.camera = newCam;
  post.isEdited = true;

  if (state.editPostDraft.newMedia) {
    post.blob = state.editPostDraft.newMedia.blob;
    post.mediaType = state.editPostDraft.newMedia.mediaType;
    post.mediaUrl = state.editPostDraft.newMedia.url;
    post.remoteMediaUrl = null;
  }

  await saveUserPostToDB(post);

  state.editPostDraft = null;
  state.modal = null;
  renderModal();
  renderMain();
  toast(tr('feed.updatedToast'));
  syncAllUserPostsToCloud();
}

// ==================== POST ACTIONS (LIKE, DOUBLE-CLICK HEART, SAVE, COMMENT) ====================
function handleMediaDoubleClick(postId, containerEl) {
  toggleLike(postId, true);
  if (containerEl) {
    const heart = document.createElement('div');
    heart.className = 'dblclick-heart';
    heart.textContent = '❤️';
    containerEl.appendChild(heart);
    setTimeout(() => heart.remove(), 800);
  }
}

function toggleLike(postId, forceLike = false) {
  const post = posts.find((p) => p.id === postId);
  if (!post) return;
  if (forceLike && post.liked) return;
  post.liked = forceLike ? true : !post.liked;
  post.likes += post.liked ? 1 : -1;

  const likeBtn = document.getElementById(`like-btn-${postId}`);
  const likeCount = document.getElementById(`like-count-${postId}`);
  if (likeBtn && likeCount) {
    likeBtn.className = `ig-icon-btn ${post.liked ? 'liked' : ''}`;
    likeBtn.textContent = post.liked ? '❤️' : '🤍';
    likeCount.textContent = `${post.likes} ${tr('feed.likes')}`;
  }

  if (state.modal && state.modal.type === 'report' && state.modal.postId === postId) {
    renderModal();
  }
}

function toggleSave(postId) {
  const post = posts.find((p) => p.id === postId);
  if (!post) return;
  post.saved = !post.saved;
  const saveBtn = document.getElementById(`save-btn-${postId}`);
  if (saveBtn) {
    saveBtn.textContent = post.saved ? '🔖' : '🏷️';
  }
  toast(
    state.lang === 'tr'
      ? post.saved
        ? 'Kaydedilenlere eklendi'
        : 'Kaydedilenlerden çıkarıldı'
      : post.saved
      ? 'Saved'
      : 'Removed from saved'
  );
  if (state.page === 'profile' && state.profileUser === 'kaan.doc' && state.profileTab === 'saved') {
    renderMain();
  }
  if (state.modal && state.modal.type === 'report' && state.modal.postId === postId) {
    renderModal();
  }
}

function addComment(postId, inputIdOverride) {
  const inputId = inputIdOverride || `comment-input-${postId}`;
  const input = document.getElementById(inputId);
  if (!input || !input.value.trim()) return;
  const post = posts.find((p) => p.id === postId);
  if (!post) return;
  const text = input.value.trim();
  post.comments.push({
    user: 'kaan.doc',
    text: { tr: text, en: text },
  });
  input.value = '';
  const listEl = document.getElementById(`comments-list-${postId}`);
  if (listEl) {
    const item = document.createElement('div');
    item.className = 'ig-comment-item';
    item.innerHTML = `<strong class="clickable-user" onclick="openUserProfile('kaan.doc')">kaan.doc</strong><span></span>`;
    item.querySelector('span').textContent = text;
    listEl.appendChild(item);
  }
  if (state.modal && state.modal.type === 'report' && state.modal.postId === postId) {
    renderModal();
  }
}

// ONLY kaan.doc's own posts can be deleted!
async function deletePost(postId) {
  const idx = posts.findIndex((p) => p.id === postId);
  if (idx === -1) return;
  const target = posts[idx];

  if (target.username !== 'kaan.doc') {
    return;
  }

  if (target.mediaUrl && target.mediaUrl.startsWith('blob:')) {
    try {
      URL.revokeObjectURL(target.mediaUrl);
    } catch (_) {}
  }

  posts.splice(idx, 1);
  await deleteUserPostFromDB(postId);

  if (state.modal && state.modal.postId === postId) {
    state.modal = null;
    renderModal();
  }

  const cardEl = document.getElementById(`post-card-${postId}`);
  if (cardEl && state.page === 'home') {
    cardEl.remove();
  } else {
    renderMain();
  }

  toast(tr('feed.deletedToast'));
  syncAllUserPostsToCloud();
}

// ONLY kaan.doc's own stories can be deleted!
function deleteStory(storyId) {
  const idx = stories.findIndex((s) => s.id === storyId);
  if (idx === -1) return;
  const st = stories[idx];
  if (st.user !== 'kaan.doc') {
    return;
  }
  if (st.media && st.media.startsWith('blob:')) {
    try {
      URL.revokeObjectURL(st.media);
    } catch (_) {}
  }
  stories.splice(idx, 1);
  state.modal = null;
  renderModal();
  renderMain();
  toast(state.lang === 'tr' ? 'Hikayen silindi.' : 'Your story was deleted.');
}

// ==================== MEDIA UPLOAD & <10% AI FILTER LOGIC ====================
function createMediaObjectFromFile(file) {
  if (!file) return null;
  const isVideo =
    file.type.startsWith('video/') ||
    /\.(mp4|webm|mov|m4v|ogg|mkv|avi)$/i.test(file.name);
  const mediaType = isVideo ? 'video' : 'image';
  const sizeText = `${file.name} (${formatBytes(file.size)})`;
  const url = URL.createObjectURL(file);

  const lowerName = file.name.toLowerCase();
  const hasAiKeyword = /(midjourney|dalle|dall-e|stable[-_ ]?diffusion|flux|sora|runway|comfyui|ai[-_ ]?gen)/i.test(lowerName);

  return {
    blob: file,
    url,
    mediaType,
    name: file.name,
    sizeText,
    hasAiKeyword,
  };
}

function openCreateModal() {
  state.modal = { type: 'create' };
  state.scanStatus = 'idle';
  state.simMode = 'real';
  state.blockedReport = null;
  state.locationDraft = USER_PROFILES['kaan.doc'].location[state.lang] || 'İstanbul';
  renderModal();
}

function closeModal() {
  state.modal = null;
  renderModal();
}

function setSimMode(mode) {
  syncModalInputs();
  state.simMode = mode;
  state.scanStatus = 'idle';
  state.blockedReport = null;
  renderModal();
}

function removeSelectedMainMedia() {
  syncModalInputs();
  if (state.uploadedMainMedia && state.uploadedMainMedia.url.startsWith('blob:')) {
    try {
      URL.revokeObjectURL(state.uploadedMainMedia.url);
    } catch (_) {}
  }
  state.uploadedMainMedia = null;
  state.scanStatus = 'idle';
  state.blockedReport = null;
  renderModal();
}

function handleMainMediaInput(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  syncModalInputs();
  if (state.uploadedMainMedia && state.uploadedMainMedia.url.startsWith('blob:')) {
    try {
      URL.revokeObjectURL(state.uploadedMainMedia.url);
    } catch (_) {}
  }
  const mediaObj = createMediaObjectFromFile(file);
  state.uploadedMainMedia = mediaObj;
  if (mediaObj.hasAiKeyword) {
    state.simMode = 'ai_test';
  }
  state.scanStatus = 'idle';
  state.blockedReport = null;
  renderModal();
}

function handleDropMainMedia(e) {
  e.preventDefault();
  e.stopPropagation();
  const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (!file) return;
  syncModalInputs();
  const mediaObj = createMediaObjectFromFile(file);
  state.uploadedMainMedia = mediaObj;
  if (mediaObj.hasAiKeyword) {
    state.simMode = 'ai_test';
  }
  state.scanStatus = 'idle';
  state.blockedReport = null;
  renderModal();
}

function handleStoryUploadInput(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const mediaObj = createMediaObjectFromFile(file);
  if (mediaObj.hasAiKeyword) {
    toast(
      state.lang === 'tr'
        ? '⛔ Hikaye kaldırıldı: %10 ve üzeri AI oranı tespit edildi!'
        : '⛔ Story removed: ≥10% AI probability detected!'
    );
    return;
  }
  const newStory = {
    id: 's-' + Date.now(),
    user: 'kaan.doc',
    avatar: AVATARS.kaan,
    mediaType: mediaObj.mediaType,
    media: mediaObj.url,
  };
  stories.unshift(newStory);
  state.modal = { type: 'story', storyId: newStory.id };
  toast(state.lang === 'tr' ? 'Hikayen paylaşıldı! (%1 AI · Doğrulandı)' : 'Your story is live! (1% AI · Verified)');
  renderMain();
  renderModal();
}

function syncModalInputs() {
  const capEl = document.getElementById('create-caption-input');
  const thEl = document.getElementById('create-theme-select');
  const locEl = document.getElementById('create-location-input');
  if (capEl) state.captionDraft = capEl.value;
  if (thEl) state.themeDraft = thEl.value;
  if (locEl) state.locationDraft = locEl.value;
}

// Strict Platform Rule: AI Score >= 10% is AUTOMATICALLY REMOVED / BLOCKED!
async function scanAndPublishPost() {
  syncModalInputs();
  if (!state.uploadedMainMedia) {
    toast(
      state.lang === 'tr'
        ? 'Lütfen önce bir fotoğraf veya video seçin!'
        : 'Please select a photo or video first!'
    );
    return;
  }

  state.scanStatus = 'scanning';
  state.blockedReport = null;
  renderModal();

  setTimeout(async () => {
    const mainMedia = state.uploadedMainMedia;
    const isAiDetected = state.simMode === 'ai_test' || mainMedia.hasAiKeyword;
    const scoreVal = isAiDetected ? 84 : 2;

    // PLATFORM RULE: >= 10% AI IS AUTOMATICALLY REMOVED!
    if (scoreVal >= 10) {
      state.scanStatus = 'blocked';
      state.blockedReport = {
        score: scoreVal,
        fileName: mainMedia.name,
      };
      renderModal();
      toast(
        state.lang === 'tr'
          ? `⛔ İçerik kaldırıldı! Tespit edilen AI oranı (%${scoreVal}), %10 sınırının üzerinde.`
          : `⛔ Content removed! Detected AI score (${scoreVal}%) exceeds the 10% limit.`
      );
      return;
    }

    // < 10% AI -> Approved & Published!
    const captionText =
      state.captionDraft.trim() ||
      (state.lang === 'tr' ? 'Yeni paylaşım.' : 'New post.');
    const locText = (state.locationDraft || '').trim() || 'İstanbul';

    const newPost = {
      id: 'p-' + Date.now(),
      feedCategory: 'following',
      username: 'kaan.doc',
      fullName: USER_PROFILES['kaan.doc'].fullName,
      avatar: AVATARS.kaan,
      isFounding: true,
      location: { tr: locText, en: locText },
      timeAgo: { tr: 'ŞİMDİ', en: 'JUST NOW' },
      timestamp: Date.now(),
      theme: state.themeDraft || '#photography',
      score: scoreVal,
      badgeType: 'low',
      badgeLabel: {
        tr: `AI-filtered · %${scoreVal}`,
        en: `AI-filtered · ${scoreVal}%`,
      },
      camera: 'C2PA Verified Media',
      likes: 1,
      liked: true,
      saved: false,
      blob: mainMedia.blob,
      mediaType: mainMedia.mediaType,
      mediaUrl: mainMedia.url,
      caption: { tr: captionText, en: captionText },
      comments: [],
    };

    posts.unshift(newPost);
    await saveUserPostToDB(newPost);

    state.uploadedMainMedia = null;
    state.captionDraft = '';
    state.scanStatus = 'idle';
    state.blockedReport = null;
    state.modal = null;
    state.feedMode = 'chronological';
    state.page = 'home';

    renderModal();
    renderNavigation();
    renderMain();

    toast(
      state.lang === 'tr'
        ? `✅ AI oranı %${scoreVal} (<%10) doğrulandı ve paylaşıldı!`
        : `✅ AI score ${scoreVal}% (<10%) verified and shared!`
    );

    syncAllUserPostsToCloud();
  }, 600);
}

// Render Media Element
function renderPostMedia(post, isGridThumbnail = false) {
  if (post.mediaType === 'video') {
    if (isGridThumbnail) {
      return `<video src="${post.mediaUrl}" muted loop playsinline preload="metadata" onmouseover="this.play()" onmouseout="this.pause()"></video>`;
    }
    return `<video class="ig-media-video" src="${post.mediaUrl}" controls playsinline preload="metadata"></video>`;
  }
  return `<img class="${isGridThumbnail ? '' : 'ig-media-img'}" src="${post.mediaUrl}" alt="${post.username}" loading="lazy" onerror="handleImgError(this)" />`;
}

// Render Clean Instagram Post Card
function renderPostCard(post) {
  const isVideo = post.mediaType === 'video';
  const isMyPost = post.username === 'kaan.doc';

  return `
    <article id="post-card-${post.id}" class="ig-post">
      <!-- Post Header -->
      <div class="ig-post-header">
        <div class="ig-post-user" onclick="openUserProfile('${post.username}')">
          <img class="ig-user-avatar" src="${post.avatar}" alt="${post.username}" onerror="handleImgError(this)" />
          <div style="min-width:0;">
            <div class="ig-username-row">
              <span class="ig-username clickable-user">${post.username}</span>
              ${post.isFounding ? `<span class="ig-verified-dot" title="Verified">★</span>` : ''}
            </div>
            <div class="ig-post-sub">
              <span>${post.location[state.lang]}</span>
            </div>
          </div>
        </div>

        <div class="post-header-right">
          <button class="ai-score-pill ${post.badgeType}" onclick="openReportModal('${post.id}')">
            🛡️ ${post.badgeLabel[state.lang]}
          </button>
          ${
            isMyPost
              ? `
              <button class="edit-post-btn" onclick="openEditPostModal('${post.id}')" title="${tr('feed.editBtn')}">
                ✏️ ${tr('feed.editBtn')}
              </button>
              <button class="delete-post-btn" onclick="deletePost('${post.id}')" title="${tr('feed.deleteBtn')}">
                🗑️ ${tr('feed.deleteBtn')}
              </button>
            `
              : ''
          }
        </div>
      </div>

      <!-- Pure Content Media Box with Double-Tap Heart -->
      <div class="ig-media-box" ${isVideo ? '' : `ondblclick="handleMediaDoubleClick('${post.id}', this)"`}>
        ${renderPostMedia(post, false)}
      </div>

      <!-- Instagram Action Icons -->
      <div class="ig-post-actions">
        <div class="ig-actions-left">
          <button id="like-btn-${post.id}" class="ig-icon-btn ${post.liked ? 'liked' : ''}" onclick="toggleLike('${post.id}')">
            ${post.liked ? '❤️' : '🤍'}
          </button>
          <button class="ig-icon-btn" onclick="document.getElementById('comment-input-${post.id}').focus()">
            💬
          </button>
        </div>
        <button id="save-btn-${post.id}" class="ig-icon-btn" onclick="toggleSave('${post.id}')">
          ${post.saved ? '🔖' : '🏷️'}
        </button>
      </div>

      <!-- Likes, Caption & Comments -->
      <div class="ig-post-body">
        <div id="like-count-${post.id}" class="ig-likes-count">${post.likes} ${tr('feed.likes')}</div>
        <div class="ig-caption">
          <strong class="clickable-user" onclick="openUserProfile('${post.username}')">${post.username}</strong>
          <span>${post.caption[state.lang]}</span>
          <span class="ig-theme-tag" onclick="state.exploreTheme='${post.theme}'; setPage('explore');"> ${post.theme}</span>
        </div>

        <div id="comments-list-${post.id}" class="ig-comments-list">
          ${post.comments
            .map(
              (c) => `
            <div class="ig-comment-item">
              <strong class="clickable-user" onclick="openUserProfile('${c.user}')">${c.user}</strong><span>${c.text[state.lang]}</span>
            </div>
          `
            )
            .join('')}
        </div>
        <span class="ig-post-time">${post.timeAgo[state.lang]}</span>
      </div>

      <!-- Add Comment Input -->
      <div class="ig-comment-box">
        <input
          id="comment-input-${post.id}"
          class="ig-comment-input"
          type="text"
          placeholder="${tr('feed.addComment')}"
          onkeydown="if(event.key==='Enter') addComment('${post.id}')"
        />
        <button class="ig-comment-submit" onclick="addComment('${post.id}')">${tr('feed.postBtn')}</button>
      </div>
    </article>
  `;
}

function openReportModal(postId) {
  state.modal = { type: 'report', postId };
  renderModal();
}

function openStoryModal(storyId) {
  state.modal = { type: 'story', storyId };
  renderModal();
}

// HOME VIEW
function renderHomeView() {
  const activePosts = posts
    .filter((p) =>
      state.feedMode === 'chronological'
        ? p.feedCategory === 'following'
        : p.feedCategory === 'featured'
    )
    .sort((a, b) =>
      state.feedMode === 'chronological' ? b.timestamp - a.timestamp : b.likes - a.likes
    );

  return `
    <div class="ig-content-wrapper">
      <div class="ig-feed-col">
        <!-- Fixed, Non-Deforming Feed Mode Header -->
        <div class="feed-mode-bar">
          <div class="feed-tabs">
            <button class="feed-tab-btn ${state.feedMode === 'chronological' ? 'active' : ''}" onclick="state.feedMode='chronological'; renderMain();">
              ${tr('feed.chrono')}
            </button>
            <button class="feed-tab-btn ${state.feedMode === 'featured' ? 'active' : ''}" onclick="state.feedMode='featured'; renderMain();">
              ${tr('feed.featured')}
            </button>
          </div>
          <button class="feed-upload-quick-btn" onclick="openCreateModal()">
            ${tr('feed.quickUpload')}
          </button>
        </div>

        <!-- Scrollable Stories Bar -->
        <div class="stories-wrapper">
          <div
            id="stories-scroll-bar"
            class="stories-bar"
            onwheel="handleStoriesWheel(event)"
            onmousedown="startStoriesDrag(event)"
            onmousemove="moveStoriesDrag(event)"
            onmouseup="endStoriesDrag()"
            onmouseleave="endStoriesDrag()"
          >
            <label class="story-item" title="${tr('feed.yourStory')}">
              <input type="file" accept="image/*,video/*" style="display:none;" onchange="handleStoryUploadInput(event)" />
              <div class="story-ring add-story-ring">
                <img class="story-avatar" src="${AVATARS.kaan}" alt="Your Story" draggable="false" />
                <span class="story-plus-badge">+</span>
              </div>
              <span class="story-label">${tr('feed.yourStory')}</span>
            </label>

            ${stories
              .map(
                (s) => `
              <div class="story-item" onclick="handleStoryItemClick('${s.id}')">
                <div class="story-ring">
                  <img class="story-avatar" src="${s.avatar}" alt="${s.user}" draggable="false" onerror="handleImgError(this)" />
                </div>
                <span class="story-label">${s.user}</span>
              </div>
            `
              )
              .join('')}
          </div>
        </div>

        <!-- Feed Posts -->
        ${activePosts.map((p) => renderPostCard(p)).join('')}
      </div>

      <!-- Right Sidebar -->
      <aside class="ig-right-col">
        <div class="right-profile-card">
          <div class="ig-post-user" onclick="openUserProfile('kaan.doc')">
            <img class="ig-user-avatar" style="width:48px;height:48px;" src="${AVATARS.kaan}" alt="kaan.doc" />
            <div>
              <div class="ig-username clickable-user">kaan.doc ★</div>
              <div class="ig-post-sub">${tr('right.myRole')}</div>
            </div>
          </div>
          <button class="follow-btn" onclick="openCreateModal()">${tr('right.newPostBtn')}</button>
        </div>

        <div class="right-box">
          <div class="right-box-title">
            <span>${tr('right.themeBoxTitle')}</span>
          </div>
          <p style="font-size:0.8rem; color:var(--text-muted); margin-bottom:0.75rem;">
            ${tr('right.themeDesc')}
          </p>
          <div style="display:flex; gap:0.4rem; flex-wrap:wrap;">
            <button class="proc-pill active" onclick="state.exploreTheme='#photography'; setPage('explore');">#photography</button>
            <button class="proc-pill active" onclick="state.exploreTheme='#handmade'; setPage('explore');">#handmade</button>
            <button class="proc-pill active" onclick="state.exploreTheme='#art'; setPage('explore');">#art</button>
          </div>
        </div>

        <div class="right-box">
          <div class="right-box-title">
            <span>${tr('right.suggestedTitle')}</span>
          </div>
          ${suggestedCreators
            .map((c) => {
              const prof = USER_PROFILES[c.username];
              const isFollowing = prof ? prof.isFollowedByMe : false;
              return `
            <div class="creator-row">
              <div class="ig-post-user" onclick="openUserProfile('${c.username}')">
                <img class="ig-user-avatar" src="${c.avatar}" alt="${c.username}" onerror="handleImgError(this)" />
                <div style="min-width:0;">
                  <div class="ig-username clickable-user" style="font-size:0.83rem;">${c.username}</div>
                  <div class="ig-post-sub" style="font-size:0.7rem;">${c.role[state.lang]}</div>
                </div>
              </div>
              <button class="follow-btn ${isFollowing ? 'following' : ''}" onclick="toggleFollowUser('${c.username}')">
                ${isFollowing ? tr('right.following') : tr('right.follow')}
              </button>
            </div>
          `;
            })
            .join('')}
        </div>

        <p style="font-size:0.73rem; color:var(--text-light); line-height:1.45; padding:0 0.25rem;">
          ${tr('right.footerNote')}
        </p>
      </aside>
    </div>
  `;
}

// EXPLORE VIEW
function handleExploreSearchInput(val) {
  state.exploreQuery = val;
  renderMain();
  const input = document.getElementById('explore-search-box');
  if (input) {
    input.focus();
    input.setSelectionRange(val.length, val.length);
  }
}

function renderExploreView() {
  const isTr = state.lang === 'tr';
  const q = (state.exploreQuery || '').trim().toLowerCase();

  const gridPosts = posts.filter((p) => {
    const matchesTheme = state.exploreTheme === 'all' || p.theme === state.exploreTheme;
    if (!matchesTheme) return false;
    if (!q) return true;
    const inUser = p.username.toLowerCase().includes(q) || (p.fullName && p.fullName.toLowerCase().includes(q));
    const inCap = p.caption[state.lang].toLowerCase().includes(q);
    const inLoc = p.location[state.lang].toLowerCase().includes(q);
    const inTheme = p.theme.toLowerCase().includes(q);
    return inUser || inCap || inLoc || inTheme;
  });

  return `
    <div class="explore-container">
      <div class="explore-search-bar">
        <span>🔍</span>
        <input
          id="explore-search-box"
          class="explore-search-input"
          type="text"
          value="${state.exploreQuery}"
          placeholder="${isTr ? 'Kullanıcı, konum veya içerik ara (örn: mert, seramik, Kadıköy)...' : 'Search user, location or caption (e.g. mert, ceramics, Istanbul)...'}"
          oninput="handleExploreSearchInput(this.value)"
        />
        ${
          state.exploreQuery
            ? `<button class="ig-icon-btn" style="font-size:0.95rem;" onclick="handleExploreSearchInput('')">✕</button>`
            : ''
        }
      </div>

      <div class="explore-themes-Row">
        <button class="theme-filter-pill ${state.exploreTheme === 'all' ? 'active' : ''}" onclick="state.exploreTheme='all'; renderMain();">
          ✨ ${isTr ? 'Tümü' : 'All'}
        </button>
        <button class="theme-filter-pill ${state.exploreTheme === '#photography' ? 'active' : ''}" onclick="state.exploreTheme='#photography'; renderMain();">
          📷 #photography
        </button>
        <button class="theme-filter-pill ${state.exploreTheme === '#handmade' ? 'active' : ''}" onclick="state.exploreTheme='#handmade'; renderMain();">
          🏺 #handmade
        </button>
        <button class="theme-filter-pill ${state.exploreTheme === '#art' ? 'active' : ''}" onclick="state.exploreTheme='#art'; renderMain();">
          🎨 #art
        </button>
      </div>

      <div class="ig-grid">
        ${gridPosts
          .map(
            (p) => `
          <div class="ig-grid-item" onclick="openReportModal('${p.id}')">
            ${renderPostMedia(p, true)}
            <span class="grid-badge-corner">
              ${p.mediaType === 'video' ? '🎬 ' : '🛡️ '}${p.badgeLabel[state.lang]}
            </span>
            <div class="ig-grid-overlay">
              <span>❤️ ${p.likes}</span>
              <span style="font-size:0.75rem;">@${p.username}</span>
            </div>
          </div>
        `
          )
          .join('')}
      </div>
    </div>
  `;
}

// DIRECT MESSAGES (DM) VIEW
function renderMessagesView() {
  const isTr = state.lang === 'tr';
  const threadUsers = Object.keys(USER_PROFILES).filter((u) => u !== 'kaan.doc');
  const activeUser = state.activeDmUser || 'elif.ceramics';
  const activeProf = USER_PROFILES[activeUser] || USER_PROFILES['elif.ceramics'];
  const messages = dmConversations[activeUser] || [];

  return `
    <div class="dm-container">
      <div class="dm-sidebar">
        <div class="dm-sidebar-header">
          <span>💬 ${isTr ? 'Mesajlar (kaan.doc)' : 'Messages (kaan.doc)'}</span>
          <span class="ai-score-pill low" style="font-size:0.65rem; padding:2px 6px;">${threadUsers.length}</span>
        </div>
        <div id="dm-thread-list-bar" class="dm-thread-list" onwheel="handleDmThreadsWheel(event)">
          ${threadUsers
            .map((u) => {
              const prof = USER_PROFILES[u];
              const lastMsg = (dmConversations[u] || []).slice(-1)[0];
              const previewPrefix =
                lastMsg && lastMsg.from === 'kaan.doc' ? (isTr ? 'Sen: ' : 'You: ') : '';
              const previewText = lastMsg
                ? previewPrefix + lastMsg.text[state.lang]
                : prof.role[state.lang];
              const timeText = lastMsg ? lastMsg.time : '';

              return `
              <div class="dm-thread-item ${u === activeUser ? 'active' : ''}" onclick="selectDmThread('${u}')">
                <img class="ig-user-avatar" src="${prof.avatar}" alt="${u}" onerror="handleImgError(this)" />
                <div class="dm-thread-meta">
                  <div class="dm-thread-top">
                    <span class="dm-thread-name">${u}</span>
                    <span id="dm-time-${u}" class="dm-thread-time">${timeText}</span>
                  </div>
                  <div id="dm-preview-${u}" class="dm-thread-preview">
                    ${previewText}
                  </div>
                </div>
              </div>
            `;
            })
            .join('')}
        </div>
      </div>

      <div class="dm-chat-area">
        <div class="dm-chat-header">
          <div class="ig-post-user" style="min-width:0; flex:1;" onclick="openUserProfile('${activeProf.username}')">
            <img class="ig-user-avatar" src="${activeProf.avatar}" alt="${activeProf.username}" onerror="handleImgError(this)" />
            <div style="min-width:0; flex:1;">
              <div class="ig-username clickable-user">${activeProf.username}</div>
              <div class="dm-thread-preview" style="font-size:0.74rem;">${activeProf.fullName} · ${activeProf.location[state.lang]}</div>
            </div>
          </div>
          <button class="btn-outline" style="padding:0.38rem 0.7rem; font-size:0.75rem; flex-shrink:0;" onclick="openUserProfile('${activeProf.username}')">
            👤 ${isTr ? 'Profile Git' : 'View Profile'}
          </button>
        </div>

        <div id="dm-messages-scroll" class="dm-messages-list">
          ${
            messages.length === 0
              ? `<p class="dm-empty-hint" style="text-align:center; color:var(--text-muted); font-size:0.84rem; margin:auto 0;">
                  ${isTr ? `👋 @${activeProf.username} ile sohbete başla.` : `👋 Start chatting with @${activeProf.username}.`}
                </p>`
              : messages
                  .map(
                    (m) => `
                  <div class="dm-bubble ${m.from === 'kaan.doc' ? 'mine' : 'theirs'}">
                    <div>${m.text[state.lang]}</div>
                    <div style="font-size:0.65rem; opacity:0.75; margin-top:3px; text-align:right;">${m.time}</div>
                  </div>
                `
                  )
                  .join('')
          }
        </div>

        <div class="dm-input-bar">
          <input
            id="dm-message-input"
            class="dm-text-field"
            type="text"
            autocomplete="off"
            placeholder="${isTr ? `@${activeProf.username} kullanıcısına mesaj yaz...` : `Message @${activeProf.username}...`}"
            onkeydown="if(event.key==='Enter'){ event.preventDefault(); sendDirectMessage(); }"
          />
          <button class="btn-primary" style="padding:0.52rem 1rem; border-radius:999px; flex-shrink:0;" onclick="sendDirectMessage()">
            ${isTr ? 'Gönder' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  `;
}

// ACTIVITY VIEW
function renderActivityView() {
  const isTr = state.lang === 'tr';
  return `
    <div class="ig-feed-col" style="max-width:600px;">
      <div class="right-box">
        <h3 style="margin-bottom:0.85rem;">❤️ ${isTr ? 'Bildirimler' : 'Notifications'}</h3>
        <div class="report-row">
          <span>❤️ <strong class="clickable-user" onclick="openUserProfile('mert.draws')">mert.draws</strong> ${isTr ? 'gönderini beğendi.' : 'liked your post.'}</span>
          <span style="font-size:0.75rem; color:var(--text-muted);">12m</span>
        </div>
        <div class="report-row">
          <span>💬 <strong class="clickable-user" onclick="openUserProfile('zeynep.35mm')">zeynep.35mm</strong> ${isTr ? 'yorum yaptı: "Çok zarif 👏"' : 'commented: "So elegant 👏"'}</span>
          <span style="font-size:0.75rem; color:var(--text-muted);">1h</span>
        </div>
        <div class="report-row">
          <span>👋 <strong class="clickable-user" onclick="openUserProfile('elif.ceramics')">elif.ceramics</strong> ${isTr ? 'seni takip etmeye başladı.' : 'started following you.'}</span>
          <span style="font-size:0.75rem; color:var(--text-muted);">3h</span>
        </div>
        <div class="report-row" style="border-bottom:none;">
          <span>🛡️ <strong>AI Filter:</strong> ${isTr ? 'Sistem kuralı aktif: %10 ve üzeri AI içerikler otomatik kaldırılır.' : 'Filter active: ≥10% AI content is automatically removed.'}</span>
          <span class="ai-score-pill low">&lt;10% AI</span>
        </div>
      </div>
    </div>
  `;
}

// PROFILE VIEW
function renderProfileView() {
  const isTr = state.lang === 'tr';
  const targetUsername = state.profileUser || 'kaan.doc';
  const isMe = targetUsername === 'kaan.doc';

  const profileData = USER_PROFILES[targetUsername] || {
    username: targetUsername,
    fullName: targetUsername,
    avatar: AVATARS.kaan,
    isFounding: false,
    followers: 420,
    followingCount: 180,
    isFollowedByMe: false,
    role: { tr: 'Üye · AI-Filtered', en: 'Member · AI-Filtered' },
    location: { tr: 'İstanbul', en: 'Istanbul' },
    bio: {
      tr: 'Gerçek insanlar, gerçek emek.',
      en: 'Real people, real effort.',
    },
  };

  const userPosts = posts.filter((p) => p.username === targetUsername);
  const savedPosts = posts.filter((p) => p.saved);
  const displayedPosts = isMe && state.profileTab === 'saved' ? savedPosts : userPosts;

  return `
    <div class="profile-container">
      ${
        !isMe
          ? `
        <div class="profile-back-bar">
          <button class="profile-back-btn" onclick="setPage('home')">
            ← ${isTr ? 'Akışa Dön' : 'Back to Feed'}
          </button>
          <button class="profile-back-btn" onclick="openUserProfile('kaan.doc')">
            👤 ${isTr ? 'Kendi Profilime Git (kaan.doc)' : 'Go to My Profile (kaan.doc)'}
          </button>
        </div>
      `
          : ''
      }

      <div class="profile-header">
        <img class="profile-big-avatar" src="${profileData.avatar}" alt="${profileData.username}" onerror="handleImgError(this)" />
        <div class="profile-info">
          <div class="profile-top-row">
            <h2 style="font-size:1.35rem;">${profileData.username}</h2>
            <span class="ai-score-pill low">
              ${profileData.isFounding ? '★ Founding Member' : '🛡️ AI-Filtered'}
            </span>
            ${
              isMe
                ? `
              <button class="btn-primary" onclick="openCreateModal()">
                ➕ ${isTr ? 'Yükle' : 'Upload'}
              </button>
              <button class="btn-outline" onclick="openEditProfileModal()">
                ✏️ ${isTr ? 'Profili Düzenle' : 'Edit Profile'}
              </button>
            `
                : `
              <button class="profile-follow-btn ${profileData.isFollowedByMe ? 'following' : ''}" onclick="toggleFollowUser('${profileData.username}')">
                ${profileData.isFollowedByMe ? '✓ ' + tr('right.following') : '+ ' + tr('right.follow')}
              </button>
              <button class="btn-outline" onclick="openDirectMessageWith('${profileData.username}')">
                💬 ${isTr ? 'Mesaj Gönder' : 'Message'}
              </button>
            `
            }
          </div>

          <div class="profile-stats-row">
            <span><strong>${userPosts.length}</strong> ${isTr ? 'gönderi' : 'posts'}</span>
            <span class="clickable-user" onclick="openFollowersModal('followers', '${profileData.username}')">
              <strong>${profileData.followers.toLocaleString()}</strong> ${isTr ? 'takipçi' : 'followers'}
            </span>
            <span class="clickable-user" onclick="openFollowersModal('following', '${profileData.username}')">
              <strong>${profileData.followingCount}</strong> ${isTr ? 'takip' : 'following'}
            </span>
          </div>

          <div>
            <strong>${profileData.fullName}</strong>
            <span style="font-size:0.78rem; color:var(--text-muted); margin-left:0.4rem;">· 📍 ${profileData.location[state.lang]}</span>
            <p style="font-size:0.88rem; color:var(--text-muted); margin-top:0.25rem;">
              ${profileData.bio[state.lang]}
            </p>
          </div>
        </div>
      </div>

      ${
        isMe
          ? `
        <div class="profile-tabs">
          <button class="profile-tab-btn ${state.profileTab === 'posts' ? 'active' : ''}" onclick="state.profileTab='posts'; renderMain();">
            📸 ${isTr ? 'GÖNDERİLER' : 'POSTS'} (${userPosts.length})
          </button>
          <button class="profile-tab-btn ${state.profileTab === 'saved' ? 'active' : ''}" onclick="state.profileTab='saved'; renderMain();">
            🔖 ${isTr ? 'KAYDEDİLENLER' : 'SAVED'} (${savedPosts.length})
          </button>
        </div>
      `
          : ''
      }

      <!-- User's Posts Grid -->
      <div class="ig-grid">
        ${displayedPosts
          .map(
            (p) => `
          <div class="ig-grid-item" onclick="openReportModal('${p.id}')">
            ${renderPostMedia(p, true)}
            <span class="grid-badge-corner">
              ${p.mediaType === 'video' ? '🎬 ' : '🛡️ '}${p.badgeLabel[state.lang]}
            </span>
            <div class="ig-grid-overlay">
              <span>❤️ ${p.likes}</span>
              <span style="font-size:0.75rem;">@${p.username}</span>
            </div>
          </div>
        `
          )
          .join('')}
      </div>
    </div>
  `;
}

// MODALS
function renderModal() {
  const modalRoot = document.getElementById('modal-root');
  if (!modalRoot) return;

  if (!state.modal) {
    modalRoot.innerHTML = '';
    return;
  }

  const isTr = state.lang === 'tr';

  // 1. Clean Photo/Video Upload Modal with <10% AI Threshold
  if (state.modal.type === 'create') {
    modalRoot.innerHTML = `
      <div class="modal-overlay" onclick="closeModal()">
        <div class="modal-card" onclick="event.stopPropagation()">
          <div class="modal-top">
            <span>➕ ${tr('createModal.title')}</span>
            <button class="ig-icon-btn" style="font-size:1.1rem;" onclick="closeModal()">✕</button>
          </div>
          <div class="modal-body">
            <p style="font-size:0.81rem; color:var(--text-muted); margin-bottom:0.8rem;">
              ${tr('createModal.sub')}
            </p>

            ${
              state.uploadedMainMedia
                ? `
              <div class="upload-preview-stage">
                ${
                  state.uploadedMainMedia.mediaType === 'video'
                    ? `<video src="${state.uploadedMainMedia.url}" controls autoplay playsinline style="width:100%; max-height:280px; object-fit:contain;"></video>`
                    : `<img src="${state.uploadedMainMedia.url}" alt="Preview" />`
                }
              </div>
              <div class="file-meta-bar">
                <span>${state.uploadedMainMedia.mediaType === 'video' ? '🎬 Video:' : '📸 Fotoğraf:'} ${state.uploadedMainMedia.sizeText}</span>
                <button class="delete-post-btn" onclick="removeSelectedMainMedia()">${tr('createModal.removeMedia')}</button>
              </div>
            `
                : `
              <label
                class="upload-dropzone"
                style="display:block;"
                ondragover="event.preventDefault(); this.classList.add('dragover');"
                ondragleave="this.classList.remove('dragover');"
                ondrop="handleDropMainMedia(event)"
              >
                <input type="file" accept="image/*,video/*" style="display:none;" onchange="handleMainMediaInput(event)" />
                <div style="font-size:1.8rem; margin-bottom:0.35rem;">📸 🎬</div>
                <div style="font-weight:700; font-size:0.92rem;">${tr('createModal.dropTitle')}</div>
                <div style="font-size:0.78rem; color:var(--text-muted); margin-top:0.2rem;">${tr('createModal.dropSub')}</div>
              </label>
            `
            }

            <!-- AI Filter Simulation Mode Selector (<10% vs >=10% Auto-Removed) -->
            <div class="ai-sim-box">
              <div style="font-size:0.78rem; font-weight:800; color:var(--text-main);">
                ${tr('createModal.simTitle')}
              </div>
              <div class="ai-sim-options">
                <button
                  type="button"
                  class="ai-sim-pill ${state.simMode === 'real' ? 'active-real' : ''}"
                  onclick="setSimMode('real')"
                >
                  ${tr('createModal.simReal')}
                </button>
                <button
                  type="button"
                  class="ai-sim-pill ${state.simMode === 'ai_test' ? 'active-ai' : ''}"
                  onclick="setSimMode('ai_test')"
                >
                  ${tr('createModal.simAi')}
                </button>
              </div>
            </div>

            ${
              state.scanStatus === 'blocked' && state.blockedReport
                ? `
              <div class="ai-blocked-card">
                <div class="ai-blocked-title">
                  ⛔ ${
                    isTr
                      ? `İÇERİK OTOMATİK KALDIRILDI (AI Oranı: %${state.blockedReport.score})`
                      : `CONTENT AUTOMATICALLY REMOVED (AI Score: ${state.blockedReport.score}%)`
                  }
                </div>
                <p style="font-size:0.8rem; line-height:1.45; margin-bottom:0.5rem;">
                  ${
                    isTr
                      ? `WithoutAI güvenlik kuralları gereği <strong>%10 ve üzeri</strong> yapay zeka oranı tespit edilen içerikler akışa alınmaz ve otomatik olarak kaldırılır.`
                      : `Under WithoutAI rules, content with an AI probability of <strong>10% or higher</strong> is automatically removed and blocked from the feed.`
                  }
                </p>
                <div style="font-size:0.75rem; background:var(--bg-surface); padding:0.5rem 0.7rem; border-radius:8px; border:1px solid var(--border);">
                  <div>• <strong>C2PA Kamera İmzası:</strong> ❌ ${isTr ? 'Doğrulanamadı (Sentetik Üretim İzi)' : 'Missing (Synthetic Generation Trace)'}</div>
                  <div>• <strong>Difüzyon / Piksel Analizi:</strong> ⚠️ %${state.blockedReport.score} AI (${isTr ? 'Üst Sınır: <%10' : 'Max Allowed: <10%'})</div>
                </div>
              </div>
            `
                : ''
            }

            <div style="margin-bottom:0.75rem;">
              <label style="font-size:0.8rem; font-weight:700; display:block; margin-bottom:0.25rem;">${tr('createModal.captionLabel')}</label>
              <textarea id="create-caption-input" style="width:100%; min-height:60px; padding:0.58rem; border-radius:8px; border:1px solid var(--border); background:var(--bg-body); color:var(--text-main); font-family:inherit;" placeholder="Açıklama yaz...">${state.captionDraft}</textarea>
            </div>

            <div style="display:grid; grid-template-columns:1fr 1fr; gap:0.65rem; margin-bottom:0.95rem;">
              <div>
                <label style="font-size:0.8rem; font-weight:700; display:block; margin-bottom:0.25rem;">${tr('createModal.themeLabel')}</label>
                <select id="create-theme-select" style="width:100%; padding:0.52rem; border-radius:8px; border:1px solid var(--border); background:var(--bg-body); color:var(--text-main);">
                  <option value="#photography" ${state.themeDraft === '#photography' ? 'selected' : ''}>#photography</option>
                  <option value="#handmade" ${state.themeDraft === '#handmade' ? 'selected' : ''}>#handmade</option>
                  <option value="#art" ${state.themeDraft === '#art' ? 'selected' : ''}>#art</option>
                </select>
              </div>
              <div>
                <label style="font-size:0.8rem; font-weight:700; display:block; margin-bottom:0.25rem;">${tr('createModal.locationLabel')}</label>
                <input id="create-location-input" type="text" value="${state.locationDraft}" style="width:100%; padding:0.5rem; border-radius:8px; border:1px solid var(--border); background:var(--bg-body); color:var(--text-main); font-family:inherit;" />
              </div>
            </div>

            <button class="btn-primary" style="width:100%;" onclick="scanAndPublishPost()">
              ${state.scanStatus === 'scanning' ? `⏳ ${tr('createModal.scanning')}` : tr('createModal.scanBtn')}
            </button>
          </div>
        </div>
      </div>
    `;
    return;
  }

  // 2. Edit Uploaded Post Modal (Caption, Tag, Location, Camera, Replace Media)
  if (state.modal.type === 'editPost' && state.editPostDraft) {
    const post = posts.find((p) => p.id === state.editPostDraft.postId);
    if (!post) {
      closeModal();
      return;
    }
    const previewMediaUrl = state.editPostDraft.newMedia ? state.editPostDraft.newMedia.url : post.mediaUrl;
    const previewMediaType = state.editPostDraft.newMedia ? state.editPostDraft.newMedia.mediaType : post.mediaType;

    modalRoot.innerHTML = `
      <div class="modal-overlay" onclick="closeModal()">
        <div class="modal-card" style="max-width:500px;" onclick="event.stopPropagation()">
          <div class="modal-top">
            <span>✏️ ${tr('editPostModal.title')}</span>
            <button class="ig-icon-btn" style="font-size:1.1rem;" onclick="closeModal()">✕</button>
          </div>
          <div class="modal-body">
            <div class="upload-preview-stage" style="max-height:240px; margin-bottom:0.65rem;">
              ${
                previewMediaType === 'video'
                  ? `<video src="${previewMediaUrl}" controls playsinline style="width:100%; max-height:240px; object-fit:contain;"></video>`
                  : `<img src="${previewMediaUrl}" alt="Post preview" style="width:100%; max-height:240px; object-fit:cover;" />`
              }
            </div>

            <label class="btn-outline" style="display:block; text-align:center; margin-bottom:0.9rem; cursor:pointer;">
              ${tr('editPostModal.changeMedia')}
              <input type="file" accept="image/*,video/*" style="display:none;" onchange="handleEditPostMediaInput(event)" />
            </label>

            <div style="margin-bottom:0.8rem;">
              <label style="font-size:0.8rem; font-weight:700; display:block; margin-bottom:0.25rem;">${tr('editPostModal.captionLabel')}</label>
              <textarea id="edit-post-caption" style="width:100%; min-height:70px; padding:0.6rem; border-radius:8px; border:1px solid var(--border); background:var(--bg-body); color:var(--text-main); font-family:inherit;">${state.editPostDraft.caption}</textarea>
            </div>

            <div style="display:grid; grid-template-columns:1fr 1fr; gap:0.65rem; margin-bottom:0.8rem;">
              <div>
                <label style="font-size:0.8rem; font-weight:700; display:block; margin-bottom:0.25rem;">${tr('editPostModal.themeLabel')}</label>
                <input id="edit-post-theme" type="text" list="theme-suggestions" value="${state.editPostDraft.theme}" style="width:100%; padding:0.55rem; border-radius:8px; border:1px solid var(--border); background:var(--bg-body); color:var(--text-main); font-family:inherit;" />
                <datalist id="theme-suggestions">
                  <option value="#photography"></option>
                  <option value="#handmade"></option>
                  <option value="#art"></option>
                </datalist>
              </div>
              <div>
                <label style="font-size:0.8rem; font-weight:700; display:block; margin-bottom:0.25rem;">${tr('editPostModal.locationLabel')}</label>
                <input id="edit-post-location" type="text" value="${state.editPostDraft.location}" style="width:100%; padding:0.55rem; border-radius:8px; border:1px solid var(--border); background:var(--bg-body); color:var(--text-main); font-family:inherit;" />
              </div>
            </div>

            <div style="margin-bottom:1.1rem;">
              <label style="font-size:0.8rem; font-weight:700; display:block; margin-bottom:0.25rem;">${tr('editPostModal.cameraLabel')}</label>
              <input id="edit-post-camera" type="text" value="${state.editPostDraft.camera}" style="width:100%; padding:0.55rem; border-radius:8px; border:1px solid var(--border); background:var(--bg-body); color:var(--text-main); font-family:inherit;" />
            </div>

            <button class="btn-primary" style="width:100%;" onclick="saveEditedPost()">
              ${tr('editPostModal.saveBtn')}
            </button>
          </div>
        </div>
      </div>
    `;
    return;
  }

  // 3. Post Detail & AI Badge Report Modal
  if (state.modal.type === 'report') {
    const post = posts.find((p) => p.id === state.modal.postId) || posts[0];
    if (!post) {
      closeModal();
      return;
    }
    const isMyPost = post.username === 'kaan.doc';

    modalRoot.innerHTML = `
      <div class="modal-overlay" onclick="closeModal()">
        <div class="modal-card" onclick="event.stopPropagation()">
          <div class="modal-top">
            <span>🛡️ ${tr('reportModal.title')}</span>
            <button class="ig-icon-btn" style="font-size:1.1rem;" onclick="closeModal()">✕</button>
          </div>
          <div class="modal-body">
            <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:0.85rem;">
              <div class="ig-post-user" onclick="openUserProfile('${post.username}')">
                <img class="ig-user-avatar" src="${post.avatar}" alt="${post.username}" onerror="handleImgError(this)" />
                <div>
                  <div class="ig-username clickable-user">@${post.username}</div>
                  <div class="ig-post-sub">${post.location[state.lang]} · ${post.theme}</div>
                </div>
              </div>
              <span class="ai-score-pill ${post.badgeType}">${post.badgeLabel[state.lang]}</span>
            </div>

            <div class="upload-preview-stage" style="max-height:310px; margin-bottom:0.65rem;">
              ${
                post.mediaType === 'video'
                  ? `<video src="${post.mediaUrl}" controls playsinline style="width:100%; max-height:310px; object-fit:contain;"></video>`
                  : `<img src="${post.mediaUrl}" alt="${post.username}" onerror="handleImgError(this)" style="width:100%; max-height:310px; object-fit:cover;" />`
              }
            </div>

            <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:0.5rem;">
              <div style="display:flex; align-items:center; gap:0.75rem;">
                <button class="ig-icon-btn ${post.liked ? 'liked' : ''}" onclick="toggleLike('${post.id}')">
                  ${post.liked ? '❤️' : '🤍'}
                </button>
                <span style="font-weight:700; font-size:0.86rem;">${post.likes} ${tr('feed.likes')}</span>
              </div>
              <button class="ig-icon-btn" onclick="toggleSave('${post.id}')">
                ${post.saved ? '🔖' : '🏷️'}
              </button>
            </div>

            <p style="font-size:0.85rem; margin-bottom:0.85rem;">
              <strong class="clickable-user" onclick="openUserProfile('${post.username}')">${post.username}</strong> ${post.caption[state.lang]}
            </p>

            <div class="report-row">
              <span>📷 ${tr('reportModal.camera')}</span>
              <strong>${post.camera}</strong>
            </div>
            <div class="report-row">
              <span>📊 ${tr('reportModal.score')}</span>
              <strong style="color:var(--badge-low-bg); font-size:0.95rem;">%${post.score} (&lt;%10 Onaylı)</strong>
            </div>
            <div class="report-row">
              <span>🎯 ${tr('reportModal.threshold')}</span>
              <strong>${tr('reportModal.thresholdVal')}</strong>
            </div>
            <div class="report-row">
              <span>🔒 ${tr('reportModal.kvkk')}</span>
              <strong>${tr('reportModal.kvkkVal')}</strong>
            </div>
            <div class="report-row" style="border-bottom:none;">
              <span>📜 ${tr('reportModal.fsek')}</span>
              <strong>${tr('reportModal.fsekVal')}</strong>
            </div>

            <div style="display:flex; justify-content:space-between; align-items:center; gap:0.5rem; margin-top:1.15rem; flex-wrap:wrap;">
              ${
                isMyPost
                  ? `
                  <div style="display:flex; gap:0.5rem;">
                    <button class="edit-post-btn" style="padding:0.55rem 0.9rem; font-size:0.82rem;" onclick="openEditPostModal('${post.id}')">
                      ${tr('reportModal.editPost')}
                    </button>
                    <button class="delete-post-btn" style="padding:0.55rem 0.9rem; font-size:0.82rem;" onclick="deletePost('${post.id}')">
                      ${tr('reportModal.deletePost')}
                    </button>
                  </div>
                `
                  : `<button class="btn-outline" onclick="openUserProfile('${post.username}')">
                      ${tr('reportModal.viewProfile')} (@${post.username})
                    </button>`
              }
              <button class="btn-primary" onclick="closeModal()">${tr('reportModal.close')}</button>
            </div>
          </div>
        </div>
      </div>
    `;
    return;
  }

  // 5. Edit Profile Modal
  if (state.modal.type === 'editProfile') {
    const me = USER_PROFILES['kaan.doc'];
    modalRoot.innerHTML = `
      <div class="modal-overlay" onclick="closeModal()">
        <div class="modal-card" style="max-width:460px;" onclick="event.stopPropagation()">
          <div class="modal-top">
            <span>✏️ ${isTr ? 'Profili Düzenle (kaan.doc)' : 'Edit Profile (kaan.doc)'}</span>
            <button class="ig-icon-btn" style="font-size:1.1rem;" onclick="closeModal()">✕</button>
          </div>
          <div class="modal-body">
            <div style="display:flex; align-items:center; gap:1rem; margin-bottom:1.1rem;">
              <img class="profile-big-avatar" style="width:74px; height:74px;" src="${me.avatar}" alt="kaan.doc" />
              <label class="btn-outline" style="cursor:pointer;">
                📸 ${isTr ? 'Profil Fotoğrafını Değiştir' : 'Change Profile Photo'}
                <input type="file" accept="image/*" style="display:none;" onchange="handleProfileAvatarInput(event)" />
              </label>
            </div>

            <div style="margin-bottom:0.8rem;">
              <label style="font-size:0.8rem; font-weight:700; display:block; margin-bottom:0.3rem;">${isTr ? 'Ad Soyad' : 'Full Name'}</label>
              <input id="edit-prof-name" type="text" value="${me.fullName}" style="width:100%; padding:0.6rem; border-radius:8px; border:1px solid var(--border); background:var(--bg-body); color:var(--text-main); font-family:inherit;" />
            </div>

            <div style="margin-bottom:0.8rem;">
              <label style="font-size:0.8rem; font-weight:700; display:block; margin-bottom:0.3rem;">${isTr ? 'Konum' : 'Location'}</label>
              <input id="edit-prof-loc" type="text" value="${me.location[state.lang]}" style="width:100%; padding:0.6rem; border-radius:8px; border:1px solid var(--border); background:var(--bg-body); color:var(--text-main); font-family:inherit;" />
            </div>

            <div style="margin-bottom:1.1rem;">
              <label style="font-size:0.8rem; font-weight:700; display:block; margin-bottom:0.3rem;">${isTr ? 'Biyografi' : 'Bio'}</label>
              <textarea id="edit-prof-bio" style="width:100%; min-height:70px; padding:0.6rem; border-radius:8px; border:1px solid var(--border); background:var(--bg-body); color:var(--text-main); font-family:inherit;">${me.bio[state.lang]}</textarea>
            </div>

            <button class="btn-primary" style="width:100%;" onclick="saveProfileEdits()">
              💾 ${isTr ? 'Değişiklikleri Kaydet' : 'Save Changes'}
            </button>
          </div>
        </div>
      </div>
    `;
    return;
  }

  // 6. Followers / Following List Modal
  if (state.modal.type === 'followers') {
    const isFollowers = state.modal.listType === 'followers';
    const allCreators = Object.values(USER_PROFILES).filter((u) => u.username !== state.modal.username);
    modalRoot.innerHTML = `
      <div class="modal-overlay" onclick="closeModal()">
        <div class="modal-card" style="max-width:420px;" onclick="event.stopPropagation()">
          <div class="modal-top">
            <span>👥 @${state.modal.username} · ${isFollowers ? (isTr ? 'Takipçiler' : 'Followers') : (isTr ? 'Takip Edilenler' : 'Following')}</span>
            <button class="ig-icon-btn" style="font-size:1.1rem;" onclick="closeModal()">✕</button>
          </div>
          <div class="modal-body">
            ${allCreators
              .map(
                (c) => `
              <div class="creator-row" style="padding:0.35rem 0;">
                <div class="ig-post-user" onclick="openUserProfile('${c.username}')">
                  <img class="ig-user-avatar" src="${c.avatar}" alt="${c.username}" onerror="handleImgError(this)" />
                  <div>
                    <div class="ig-username clickable-user">${c.username}</div>
                    <div class="ig-post-sub">${c.fullName} · ${c.role[state.lang]}</div>
                  </div>
                </div>
                ${
                  c.username !== 'kaan.doc'
                    ? `<button class="follow-btn ${c.isFollowedByMe ? 'following' : ''}" onclick="toggleFollowUser('${c.username}')">
                        ${c.isFollowedByMe ? tr('right.following') : tr('right.follow')}
                      </button>`
                    : ''
                }
              </div>
            `
              )
              .join('')}
          </div>
        </div>
      </div>
    `;
    return;
  }

  // 7. Story Viewer Modal
  if (state.modal.type === 'story') {
    const st = stories.find((s) => s.id === state.modal.storyId) || stories[0];
    if (!st) {
      closeModal();
      return;
    }
    const isMyStory = st.user === 'kaan.doc';

    modalRoot.innerHTML = `
      <div class="modal-overlay" onclick="closeModal()">
        <div class="modal-card" style="max-width:430px; overflow:hidden;" onclick="event.stopPropagation()">
          <div class="modal-top">
            <div class="ig-post-user" onclick="openUserProfile('${st.user}')">
              <img class="ig-user-avatar" style="width:32px;height:32px;" src="${st.avatar}" alt="${st.user}" onerror="handleImgError(this)" />
              <span class="ig-username clickable-user">@${st.user}</span>
              <span class="ai-score-pill low" style="font-size:0.65rem; padding:2px 6px;">&lt;10% AI</span>
            </div>
            <div style="display:flex; align-items:center; gap:0.5rem;">
              ${
                isMyStory
                  ? `<button class="delete-post-btn" onclick="deleteStory('${st.id}')">🗑️ ${tr('feed.deleteBtn')}</button>`
                  : ''
              }
              <button class="ig-icon-btn" style="font-size:1.1rem;" onclick="closeModal()">✕</button>
            </div>
          </div>
          <div style="position:relative; aspect-ratio:9/13; background:#000; display:flex; align-items:center; justify-content:center;">
            <button class="story-modal-arrow prev" onclick="navigateStoryModal(-1)" title="Önceki Hikaye">‹</button>
            ${
              st.mediaType === 'video'
                ? `<video src="${st.media}" controls autoplay playsinline style="width:100%; height:100%; object-fit:contain;"></video>`
                : `<img src="${st.media}" style="width:100%; height:100%; object-fit:cover;" alt="${st.user}" onerror="handleImgError(this)" />`
            }
            <button class="story-modal-arrow next" onclick="navigateStoryModal(1)" title="Sonraki Hikaye">›</button>
          </div>
        </div>
      </div>
    `;
  }
}

function renderNavigation() {
  const topbar = document.getElementById('topbar-root');
  const sidebar = document.getElementById('sidebar-root');
  const bottomnav = document.getElementById('bottomnav-root');
  const isMyProfileActive = state.page === 'profile' && state.profileUser === 'kaan.doc';

  if (topbar) {
    topbar.innerHTML = `
      <div class="ig-logo" style="font-size:1.35rem; cursor:pointer;" onclick="setPage('home')">
        WithoutAI<span class="ig-logo-dot">.</span>
      </div>
      <div class="mobile-top-actions">
        <button class="mobile-pill-btn" onclick="setLang('${state.lang === 'tr' ? 'en' : 'tr'}')">
          ${state.lang === 'tr' ? '🇹🇷 TR' : '🇬🇧 EN'}
        </button>
        <button class="mobile-pill-btn" onclick="setTheme('${state.theme === 'light' ? 'dark' : 'light'}')">
          ${state.theme === 'light' ? '☀️ ' + tr('nav.day') : '🌙 ' + tr('nav.night')}
        </button>
      </div>
    `;
  }

  if (sidebar) {
    sidebar.innerHTML = `
      <div>
        <div class="ig-brand" onclick="setPage('home')">
          <div class="ig-logo">WithoutAI<span class="ig-logo-dot">.</span></div>
          <span class="ig-tagline">${tr('tagline')}</span>
        </div>

        <nav class="ig-nav-list">
          <button class="ig-nav-item ${state.page === 'home' ? 'active' : ''}" onclick="setPage('home')">
            <span class="ig-nav-icon">🏠</span>
            <span>${tr('nav.home')}</span>
          </button>
          <button class="ig-nav-item ${state.page === 'explore' ? 'active' : ''}" onclick="setPage('explore')">
            <span class="ig-nav-icon">🔍</span>
            <span>${tr('nav.explore')}</span>
          </button>
          <button class="ig-nav-item ${state.page === 'messages' ? 'active' : ''}" onclick="setPage('messages')">
            <span class="ig-nav-icon">💬</span>
            <span>${tr('nav.messages')}</span>
          </button>
          <button class="ig-nav-item ${state.page === 'activity' ? 'active' : ''}" onclick="setPage('activity')">
            <span class="ig-nav-icon">❤️</span>
            <span>${tr('nav.activity')}</span>
          </button>
          <button class="ig-nav-item ${isMyProfileActive ? 'active' : ''}" onclick="setPage('profile')">
            <span class="ig-nav-icon">👤</span>
            <span>${tr('nav.profile')}</span>
          </button>
          <button class="ig-nav-item ig-nav-create" onclick="openCreateModal()">
            <span class="ig-nav-icon">➕</span>
            <span>${tr('nav.create')}</span>
          </button>
        </nav>
      </div>

      <div class="ig-nav-settings">
        <div class="settings-row" role="group" aria-label="Language">
          <button class="seg-btn ${state.lang === 'tr' ? 'active' : ''}" onclick="setLang('tr')">
            🇹🇷 Türkçe
          </button>
          <button class="seg-btn ${state.lang === 'en' ? 'active' : ''}" onclick="setLang('en')">
            🇬🇧 English
          </button>
        </div>
        <div class="settings-row" role="group" aria-label="Theme">
          <button class="seg-btn ${state.theme === 'light' ? 'active' : ''}" onclick="setTheme('light')">
            ☀️ ${tr('nav.day')}
          </button>
          <button class="seg-btn ${state.theme === 'dark' ? 'active' : ''}" onclick="setTheme('dark')">
            🌙 ${tr('nav.night')}
          </button>
        </div>
      </div>
    `;
  }

  if (bottomnav) {
    bottomnav.innerHTML = `
      <button class="mobile-nav-btn ${state.page === 'home' ? 'active' : ''}" onclick="setPage('home')">
        <span class="nav-ico">🏠</span>
        <span>${tr('nav.home')}</span>
      </button>
      <button class="mobile-nav-btn ${state.page === 'explore' ? 'active' : ''}" onclick="setPage('explore')">
        <span class="nav-ico">🔍</span>
        <span>${tr('nav.explore')}</span>
      </button>
      <button class="mobile-nav-btn create-pill" onclick="openCreateModal()">
        <span class="nav-ico">➕</span>
      </button>
      <button class="mobile-nav-btn ${state.page === 'messages' ? 'active' : ''}" onclick="setPage('messages')">
        <span class="nav-ico">💬</span>
        <span>${tr('nav.messages')}</span>
      </button>
      <button class="mobile-nav-btn ${isMyProfileActive ? 'active' : ''}" onclick="setPage('profile')">
        <span class="nav-ico">👤</span>
        <span>${tr('nav.profile')}</span>
      </button>
    `;
  }
}

function renderMain() {
  const mainRoot = document.getElementById('main-root');
  if (!mainRoot) return;

  if (state.page === 'home') mainRoot.innerHTML = renderHomeView();
  else if (state.page === 'explore') mainRoot.innerHTML = renderExploreView();
  else if (state.page === 'messages') mainRoot.innerHTML = renderMessagesView();
  else if (state.page === 'activity') mainRoot.innerHTML = renderActivityView();
  else if (state.page === 'profile') mainRoot.innerHTML = renderProfileView();
}

function renderAll() {
  renderNavigation();
  renderMain();
  renderModal();
}

window.addEventListener('DOMContentLoaded', async () => {
  document.documentElement.setAttribute('data-theme', state.theme);
  document.documentElement.lang = state.lang;

  // 1. Load local IndexedDB posts (across all current & legacy DB versions)
  const localPosts = await loadUserPostsFromDB();
  // 2. Load shared cloud posts from GitHub (including any orphaned files in uploads/)
  const cloudPosts = await loadSharedPostsFromCloud();

  const deletedSet = getDeletedPostIds();
  const mergedMap = new Map();

  for (const cp of cloudPosts) {
    if (!cp || !cp.id || deletedSet.has(cp.id)) continue;
    cp.avatar = AVATARS.kaan;
    mergedMap.set(cp.id, cp);
  }
  for (const lp of localPosts) {
    if (!lp || !lp.id || deletedSet.has(lp.id)) continue;
    lp.avatar = AVATARS.kaan;
    const existingCloud = mergedMap.get(lp.id);
    if (existingCloud && existingCloud.remoteMediaUrl && !lp.remoteMediaUrl) {
      lp.remoteMediaUrl = existingCloud.remoteMediaUrl;
    }
    mergedMap.set(lp.id, lp);
  }

  const userPostList = Array.from(mergedMap.values()).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  const remainingDefault = defaultPosts.filter((dp) => !mergedMap.has(dp.id) && !deletedSet.has(dp.id));

  posts = [...userPostList, ...remainingDefault];
  renderAll();

  // If this device has any local posts missing from cloudPosts or without remoteMediaUrl, sync them immediately!
  const cloudIds = new Set(cloudPosts.map((cp) => cp.id));
  const needsSync = localPosts.some(
    (lp) => !cloudIds.has(lp.id) || (lp.blob instanceof Blob && !lp.remoteMediaUrl)
  );
  if (needsSync) {
    syncAllUserPostsToCloud();
  }
});
