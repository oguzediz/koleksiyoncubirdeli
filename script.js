import { firebaseConfig, CLOUDINARY_URL, CLOUDINARY_PRESET } from './config.js';
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-app.js";
import { getFirestore, collection, addDoc, onSnapshot, query, orderBy, doc, getDoc, setDoc, updateDoc, deleteDoc } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import { getAuth, signInWithEmailAndPassword, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js";

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

let allItems = [], categoryTree = [], appSettings = { logoUrl: '' }, savedTemplates = [];
let currentMain = 'Tümü', currentSub = null, currentSubSub = null, viewMode = 'grid', activeId = null;

let currentCastArray = [];
let currentImagesArray = [];
let pendingImageFiles = [];

// --- GÖRSEL OPTİMİZASYONU (Cloudinary) ---
// Kart önizlemeleri artık orijinal boyutta değil, ekranda gösterileceği boyuta göre
// küçültülmüş + otomatik formatlı (webp/avif) + kaliteli sıkıştırılmış olarak çekiliyor.
// Blur arka planlar çok daha küçük (w_40) bir versiyon üzerinden üretiliyor; aynı görsel
// iki kere tam boyutta inmiyor.
const cld = (url, transform) => {
    if (!url || typeof url !== 'string' || !url.includes('/upload/')) return url;
    return url.replace('/upload/', `/upload/${transform}/`);
};
const cldThumb = (url) => cld(url, 'w_500,h_500,c_limit,q_auto,f_auto');
const cldBlur  = (url) => cld(url, 'w_40,q_auto,f_auto,e_blur:400');
const cldFull  = (url) => cld(url, 'w_1200,q_auto,f_auto');
const cldMini  = (url) => cld(url, 'w_100,h_100,c_fill,q_auto,f_auto');

// --- AUTHENTICATION ---
onAuthStateChanged(auth, (user) => {
    if (user) {
        // Kullanıcı giriş yapmış
        console.log("Admin giriş yaptı:", user.email);
        document.getElementById('loginBtn').style.display = 'none';
        document.getElementById('logoutBtn').style.display = 'block';
        document.getElementById('userInfo').innerText = user.email;
        document.querySelectorAll('.admin-only').forEach(el => el.style.display = 'inline-flex'); // veya 'block', 'flex' vs.
    } else {
        // Kullanıcı çıkış yapmış
        console.log("Admin oturumu kapalı.");
        document.getElementById('loginBtn').style.display = 'block';
        document.getElementById('logoutBtn').style.display = 'none';
        document.getElementById('userInfo').innerText = '';
        document.querySelectorAll('.admin-only').forEach(el => el.style.display = 'none');
    }
});

window.openLoginModal = () => { document.getElementById('loginModal').classList.add('show'); document.getElementById('globalOverlay').classList.add('show'); };

window.loginUser = async () => {
    const email = document.getElementById('loginEmail').value;
    const pass = document.getElementById('loginPassword').value;
    const errorDiv = document.getElementById('loginError');
    errorDiv.style.display = 'none';
    try { await signInWithEmailAndPassword(auth, email, pass); window.closeAll(); }
    catch (error) { errorDiv.innerText = "Hatalı e-posta veya şifre."; errorDiv.style.display = 'block'; }
};

window.logoutUser = async () => { await signOut(auth); };

const uploadImageToCloud = async (file) => {
    const fd = new FormData(); fd.append("file", file); fd.append("upload_preset", CLOUDINARY_PRESET);
    const res = await fetch(CLOUDINARY_URL, { method:"POST", body:fd }); return (await res.json()).secure_url;
};

const loadSystemData = async () => {
    const [snapSet, snapCat, snapTemp] = await Promise.all([ getDoc(doc(db, "settings", "general")), getDoc(doc(db, "settings", "categories")), getDoc(doc(db, "settings", "templates")) ]);
    
    if (snapSet.exists() && snapSet.data().logoUrl) {
        appSettings = snapSet.data(); document.getElementById('logoPlaceholder').style.display = 'none';
        document.getElementById('brandLogoImg').src = appSettings.logoUrl; document.getElementById('brandLogoImg').style.display = 'block';
    }
    categoryTree = snapCat.exists() ? snapCat.data().tree : [];
    savedTemplates = snapTemp.exists() ? snapTemp.data().list || [] : [];
    renderSidebar(); updateInCatSelect(); renderTemplateTabs();
};

window.uploadLogo = async (e) => {
    const file = e.target.files[0]; if(!file) return;
    const p = document.getElementById('logoPlaceholder'), i = document.getElementById('brandLogoImg');
    p.style.display = 'block'; i.style.display = 'none'; p.innerHTML = 'Yükleniyor...';
    try { appSettings.logoUrl = await uploadImageToCloud(file); await setDoc(doc(db, "settings", "general"), appSettings); p.style.display = 'none'; i.src = appSettings.logoUrl; i.style.display = 'block'; } catch(err) { p.innerHTML = 'Hata!'; alert('Logo yüklenirken bir hata oluştu. Lütfen giriş yaptığınızdan emin olun.'); }
};

// --- SİDEBAR RENDER ---
const renderSidebar = () => {
    const cont = document.getElementById('dynamicCategories'); cont.innerHTML = '';
    categoryTree.forEach(cat => {
        const wrap = document.createElement('div'); wrap.className = 'cat-wrapper'; wrap.setAttribute('data-id', cat.id);
        const iconHtml = cat.iconUrl ? `<img src="${cat.iconUrl}" class="cat-icon-img">` : `<i class="fa-solid fa-folder"></i>`;
        
        wrap.innerHTML = `
            <div class="category-btn" id="cbtn-${cat.id}">
                <i class="fa-solid fa-ellipsis-vertical drag-handle"></i>
                <span class="cat-name-click" onclick="window.selectMain('${cat.name}', '${cat.id}')">${iconHtml} <span class="cat-text-name">${cat.name}</span></span>
                ${cat.sub && cat.sub.length > 0 ? `<div class="toggle-sub" id="toggle-${cat.id}" onclick="window.toggleSubMenu('slist-${cat.id}', 'toggle-${cat.id}', event)"><i class="fa-solid fa-chevron-down"></i></div>` : ''}
            </div>
            <div class="sub-category-list" id="slist-${cat.id}" data-parent-id="${cat.id}">
                <div class="flyout-header">${iconHtml} <span>${cat.name}</span></div>
                ${(cat.sub || []).map(s => {
                    const subIconHtml = s.iconUrl ? `<img src="${s.iconUrl}" class="cat-icon-img">` : `<span style="opacity:0.5;">↳</span>`;
                    const hasSS = s.sub && s.sub.length > 0;
                    return `
                    <div class="sub-item-container" data-id="${s.id}">
                        <div class="sub-btn-wrapper" id="swrap-${s.id}">
                            <i class="fa-solid fa-grip-vertical sub-drag-handle"></i>
                            <button class="sub-btn" id="sbtn-${s.id}" onclick="window.selectSub('${cat.name}', '${s.name}', '${cat.id}', '${s.id}')">${subIconHtml} <span class="cat-text-name">${s.name}</span></button>
                            ${hasSS ? `<div class="toggle-sub" id="toggle-${s.id}" onclick="window.toggleSubMenu('sslist-${s.id}', 'toggle-${s.id}', event)"><i class="fa-solid fa-chevron-down" style="font-size:10px;"></i></div>` : ''}
                        </div>
                        <div class="sub-sub-category-list" id="sslist-${s.id}">
                            ${(s.sub || []).map(ss => {
                                const ssIcon = ss.iconUrl ? `<img src="${ss.iconUrl}" class="cat-icon-img" style="width:14px;height:14px;">` : `<span style="opacity:0.3; font-size:10px;">•</span>`;
                                return `<button class="sub-sub-btn" id="ssbtn-${ss.id}" onclick="window.selectSubSub('${cat.name}', '${s.name}', '${ss.name}', '${cat.id}', '${s.id}', '${ss.id}')">${ssIcon} <span class="cat-text-name">${ss.name}</span></button>`;
                            }).join('')}
                        </div>
                    </div>`
                }).join('')}
            </div>`;
        cont.appendChild(wrap);
        window.wireFlyout(wrap, cat.id);
    });
    // Sadece admin giriş yapmışsa sürükle-bırak aktif olsun
    if (auth.currentUser) {
        Sortable.create(cont, { handle: '.drag-handle', animation: 150, onEnd: async (evt) => { const item = categoryTree.splice(evt.oldIndex, 1)[0]; categoryTree.splice(evt.newIndex, 0, item); await saveTreeSilent(); } });
    document.querySelectorAll('.sub-category-list').forEach(list => { 
        Sortable.create(list, { handle: '.sub-drag-handle', animation: 150, onEnd: async (evt) => { const p = categoryTree.find(c => c.id === list.getAttribute('data-parent-id')); if(p) { const item = p.sub.splice(evt.oldIndex, 1)[0]; p.sub.splice(evt.newIndex, 0, item); await saveTreeSilent(); } }}); 
    });
    } else {
        document.querySelectorAll('.drag-handle, .sub-drag-handle').forEach(h => h.style.display = 'none');
    }
};

window.selectMain = (name, id) => { currentMain = name; currentSub = null; currentSubSub = null; document.getElementById('viewTitle').innerText = name; clearSidebarActive(); document.getElementById(`cbtn-${id}`).classList.add('active'); const slist = document.getElementById(`slist-${id}`); if(slist && !slist.classList.contains('open')) { slist.classList.add('open'); document.getElementById(`toggle-${id}`)?.classList.add('rotated'); } window.renderGallery(); window.closeMobileDrawer(); };
window.selectSub = (mName, sName, mId, sId) => { currentMain = mName; currentSub = sName; currentSubSub = null; document.getElementById('viewTitle').innerText = `${mName} / ${sName}`; clearSidebarActive(); document.getElementById(`cbtn-${mId}`).classList.add('active'); document.getElementById(`sbtn-${sId}`).classList.add('active'); const sslist = document.getElementById(`sslist-${sId}`); if(sslist && !sslist.classList.contains('open')) { sslist.classList.add('open'); document.getElementById(`toggle-${sId}`)?.classList.add('rotated'); } window.renderGallery(); window.closeMobileDrawer(); };
window.selectSubSub = (mName, sName, ssName, mId, sId, ssId) => { currentMain = mName; currentSub = sName; currentSubSub = ssName; document.getElementById('viewTitle').innerText = `${mName} / ${sName} / ${ssName}`; clearSidebarActive(); document.getElementById(`cbtn-${mId}`).classList.add('active'); document.getElementById(`sbtn-${sId}`).classList.add('active'); document.getElementById(`ssbtn-${ssId}`).classList.add('active'); window.renderGallery(); window.closeMobileDrawer(); };
window.selectAll = () => { currentMain = 'Tümü'; currentSub = null; currentSubSub = null; document.getElementById('viewTitle').innerText = 'Tüm Arşiv'; clearSidebarActive(); document.getElementById('btn-all').classList.add('active'); window.renderGallery(); window.closeMobileDrawer(); };
const clearSidebarActive = () => { document.querySelectorAll('.category-btn, .sub-btn, .sub-sub-btn').forEach(b => b.classList.remove('active')); };
window.closeMobileDrawer = () => { if (window.innerWidth <= MOBILE_BREAKPOINT) { document.getElementById('sidebar')?.classList.remove('mobile-open'); document.getElementById('globalOverlay').classList.remove('show'); } };
window.toggleSubMenu = (listId, iconId, e) => { 
    e.stopPropagation(); 
    // Eğer tıklanan yer kategori adı değilse (yani sadece ok ise) menüyü aç/kapa
    if (e.target.classList.contains('fa-chevron-down') || e.target.classList.contains('toggle-sub')) {
        document.getElementById(listId)?.classList.toggle('open'); document.getElementById(iconId)?.classList.toggle('rotated'); 
    }
};

// --- SOL PANEL: DARALT/GENİŞLET (masaüstü) + AÇ/KAPA (mobil) ---
// Masaüstünde sidebar ince bir "rail"e daralır, sadece kategori ikonları kalır; üzerine gelince
// (hover) o kategorinin alt kategorilerini gösteren yüzen bir panel (flyout) açılır.
// Mobilde (dar ekran) aynı buton yerine tam ekran kaplayan bir çekmece (drawer) açar/kapatır.
const MOBILE_BREAKPOINT = 860;
window.toggleSidebar = () => {
    const sb = document.getElementById('sidebar');
    const overlay = document.getElementById('globalOverlay');
    if (window.innerWidth <= MOBILE_BREAKPOINT) {
        const opening = !sb.classList.contains('mobile-open');
        sb.classList.toggle('mobile-open', opening);
        overlay.classList.toggle('show', opening);
    } else {
        const collapsed = sb.classList.toggle('collapsed');
        localStorage.setItem('sidebarCollapsed', collapsed ? '1' : '0');
        window.hideAllFlyouts();
    }
};

window.hideAllFlyouts = () => document.querySelectorAll('.sub-category-list.flyout-visible').forEach(el => el.classList.remove('flyout-visible'));

// Sayfa yüklendiğinde masaüstünde önceki tercihi hatırla
(() => {
    if (window.innerWidth > MOBILE_BREAKPOINT && localStorage.getItem('sidebarCollapsed') === '1') {
        document.getElementById('sidebar')?.classList.add('collapsed');
    }
})();

// Pencere mobil<->masaüstü sınırını geçerse, önceki modun durumu kalıp garip görünmesin diye sıfırla
window.addEventListener('resize', () => {
    const sb = document.getElementById('sidebar');
    if (!sb) return;
    if (window.innerWidth > MOBILE_BREAKPOINT) {
        sb.classList.remove('mobile-open');
        document.getElementById('globalOverlay').classList.remove('show');
    } else {
        sb.classList.remove('collapsed');
        window.hideAllFlyouts();
    }
});

// Rail (daraltılmış) modda kategori üzerine gelince alt kategori panelini konumlandırıp göster
window.wireFlyout = (wrapEl, catId) => {
    const btn = wrapEl.querySelector(`#cbtn-${catId}`);
    const list = wrapEl.querySelector(`#slist-${catId}`);
    if (!btn || !list) return;
    let hideTimer;
    const place = () => {
        const r = btn.getBoundingClientRect();
        list.style.top = `${Math.min(r.top, window.innerHeight - list.offsetHeight - 12)}px`;
        list.style.left = `${r.right + 10}px`;
    };
    const show = () => {
        if (!document.getElementById('sidebar').classList.contains('collapsed')) return;
        clearTimeout(hideTimer);
        window.hideAllFlyouts();
        list.classList.add('flyout-visible');
        place();
    };
    const scheduleHide = () => { hideTimer = setTimeout(() => list.classList.remove('flyout-visible'), 180); };
    wrapEl.addEventListener('mouseenter', show);
    wrapEl.addEventListener('mouseleave', scheduleHide);
    list.addEventListener('mouseenter', () => clearTimeout(hideTimer));
    list.addEventListener('mouseleave', scheduleHide);
};
window.changeView = (mode) => { viewMode = mode; document.querySelectorAll('.view-switch-btn').forEach(b => b.classList.remove('active')); document.getElementById(`v-${mode}`)?.classList.add('active'); window.renderGallery(); };

let galleryDOMNodes = {};

window.initGalleryNodes = () => {
    const grid = document.getElementById('galleryGrid');
    grid.innerHTML = '';
    galleryDOMNodes = {};
    allItems.forEach(item => {
        const card = document.createElement('div'); 
        card.className = 'card'; 
        card.onclick = () => { if(!window.isDraggingCard) window.openDetail(item.id); };
        const coverUrl = (item.images && item.images.length > 0) ? item.images[0] : item.imageUrl;
        let visual = coverUrl ? `<div class="img-container"><div class="img-blur" style="background-image:url('${cldBlur(coverUrl)}')"></div><img src="${cldThumb(coverUrl)}" class="img-front" loading="lazy" decoding="async"></div>` : `<div class="text-cover">${item.title.substring(0,2).toUpperCase()}</div>`;
        card.innerHTML = `${visual}<div class="card-info"><div class="card-title">${item.title}</div></div>`;
        grid.appendChild(card);
        galleryDOMNodes[item.id] = card;
    });
};

const loadData = () => { onSnapshot(query(collection(db, "arsiv"), orderBy("timestamp", "desc")), (s) => { 
    allItems = s.docs.map(d => ({ id: d.id, ...d.data() })); 
    window.initGalleryNodes(); 
    window.renderGallery(); 

    // Veri ilk geldiğinde, tarayıcıda ?item=ID varsa (sayfa yenilendi ya da paylaşılan link açıldı) paneli otomatik aç
    if (!deepLinkChecked) { deepLinkChecked = true; checkDeepLink(); }
}); };

window.renderGallery = () => {
    const grid = document.getElementById('galleryGrid'); 
    grid.className = `${viewMode}-view`; 
    
    if (Object.keys(galleryDOMNodes).length !== allItems.length) {
        window.initGalleryNodes();
    }

    const search = document.getElementById('searchInput').value.toLowerCase().trim();
    let visibleCount = 0;
    const visibleItems = [];

    allItems.forEach(item => {
        const matchMain = currentMain === 'Tümü' || item.category === currentMain;
        const matchSub = !currentSub || item.subCategory === currentSub;
        const matchSubSub = !currentSubSub || item.subSubCategory === currentSubSub;
        let matchSearch = !search || item.title.toLowerCase().includes(search) || (item.description && item.description.toLowerCase().includes(search));
        if (item.cast && !matchSearch) { matchSearch = item.cast.some(c => c.name.toLowerCase().includes(search) || c.role.toLowerCase().includes(search)); }
        
        const isVisible = matchMain && matchSub && matchSubSub && matchSearch;
        const node = galleryDOMNodes[item.id];
        if (node) {
            node.style.display = isVisible ? '' : 'none';
        }
        if (isVisible) {
            visibleCount++;
            visibleItems.push(item);
        }
    });

    if (viewMode === 'list') {
        grid.innerHTML = '';
        categoryTree.forEach(cat => {
            const catItems = visibleItems.filter(i => i.category === cat.name);
            if (catItems.length === 0) return;
            
            const row = document.createElement('div');
            row.className = 'netflix-row';
            row.setAttribute('data-id', cat.id);
            
            const header = document.createElement('div');
            header.className = 'netflix-row-header';
            header.innerHTML = `
                <h3 class="netflix-row-title">${cat.name}</h3>
                <i class="fa-solid fa-grip-vertical netflix-drag-handle admin-only" title="Sıralamayı Değiştir" style="display: ${auth.currentUser ? 'inline-block' : 'none'};"></i>
            `;
            
            const scrollWrap = document.createElement('div');
            scrollWrap.className = 'netflix-scroll-wrap';
            
            const scroll = document.createElement('div');
            scroll.className = 'netflix-scroll';
            catItems.forEach(item => {
                scroll.appendChild(galleryDOMNodes[item.id]);
            });
            
            const leftBtn = document.createElement('button');
            leftBtn.className = 'netflix-arrow left-arrow';
            leftBtn.innerHTML = '<i class="fa-solid fa-chevron-left"></i>';
            leftBtn.onclick = () => {
                if (scroll.scrollLeft <= 10) {
                    scroll.scrollTo({ left: scroll.scrollWidth, behavior: 'smooth' });
                } else {
                    scroll.scrollBy({ left: -scroll.clientWidth * 0.8, behavior: 'smooth' });
                }
            };
            
            const rightBtn = document.createElement('button');
            rightBtn.className = 'netflix-arrow right-arrow';
            rightBtn.innerHTML = '<i class="fa-solid fa-chevron-right"></i>';
            rightBtn.onclick = () => {
                const max = scroll.scrollWidth - scroll.clientWidth;
                if (scroll.scrollLeft >= max - 10) {
                    scroll.scrollTo({ left: 0, behavior: 'smooth' });
                } else {
                    scroll.scrollBy({ left: scroll.clientWidth * 0.8, behavior: 'smooth' });
                }
            };

            scrollWrap.appendChild(leftBtn);
            scrollWrap.appendChild(scroll);
            scrollWrap.appendChild(rightBtn);
            
            row.appendChild(header);
            row.appendChild(scrollWrap);
            grid.appendChild(row);
        });

        if (auth.currentUser && currentMain === 'Tümü' && !search && !currentSub) {
            if (window.netflixSortable) window.netflixSortable.destroy();
            window.netflixSortable = Sortable.create(grid, {
                handle: '.netflix-drag-handle',
                animation: 150,
                onEnd: async (evt) => {
                    const draggedId = evt.item.getAttribute('data-id');
                    const nextNode = evt.item.nextElementSibling;
                    const nextId = nextNode ? nextNode.getAttribute('data-id') : null;

                    const oldIdx = categoryTree.findIndex(c => c.id === draggedId);
                    if (oldIdx > -1) {
                        const item = categoryTree.splice(oldIdx, 1)[0];
                        if (nextId) {
                            const newIdx = Math.max(0, categoryTree.findIndex(c => c.id === nextId));
                            categoryTree.splice(newIdx, 0, item);
                        } else {
                            categoryTree.push(item);
                        }
                        await saveTreeSilent();
                    }
                }
            });
        }
    } else {
        if (grid.querySelector('.netflix-row') || grid.innerHTML === '') {
            grid.innerHTML = '';
            allItems.forEach(item => {
                grid.appendChild(galleryDOMNodes[item.id]);
            });
        }
    }

    let emptyMsg = document.getElementById('emptyMsg');
    if(visibleCount === 0) { 
        if (!emptyMsg) {
            emptyMsg = document.createElement('div');
            emptyMsg.id = 'emptyMsg';
            emptyMsg.style = 'grid-column:1/-1; padding:50px; text-align:center; color:#888; width:100%;';
            emptyMsg.innerText = 'Eser bulunamadı.';
            grid.appendChild(emptyMsg);
        }
        emptyMsg.style.display = 'block';
    } else {
        if (emptyMsg) emptyMsg.style.display = 'none';
    }
};

// --- ŞABLON KAYIT SİSTEMİ ---
const renderTemplateTabs = () => {
    document.getElementById('savedTemplatesList').innerHTML = savedTemplates.map(t => `<div class="tab-btn" id="tab-${t.id}" onclick="window.loadCustomTemplate('${t.id}')"><i class="fa-solid fa-star" style="color:var(--accent-color)"></i> ${t.name} <i class="fa-solid fa-trash admin-only" style="margin-left:auto; font-size:12px; color:var(--text-muted);" onclick="window.delTemplate('${t.id}', event)"></i></div>`).join('');
};

window.saveCustomTemplate = async () => {
    const name = prompt("Şablon Adı:"); if(!name) return;
    const activeMods = [];
    if(document.getElementById('wrap-images').style.display === 'block') activeMods.push('images');
    if(document.getElementById('wrap-cast').style.display === 'block') activeMods.push('cast');
    if(document.getElementById('wrap-desc').style.display === 'block') activeMods.push('desc');
    if(document.getElementById('wrap-custom').style.display === 'block') activeMods.push('custom');
    const fields = []; document.querySelectorAll('.field-row').forEach(row => fields.push({ key: row.querySelector('.f-key').value, type: row.dataset.type || 'text' }));
    
    savedTemplates.push({ id: Date.now().toString(), name, activeMods, fields, type: 'ozel' });
    await setDoc(doc(db, "settings", "templates"), { list: savedTemplates });
    renderTemplateTabs(); alert("Şablon kaydedildi!");
};

window.delTemplate = async (id, e) => { e.stopPropagation(); if(confirm('Şablon silinsin mi?')) { savedTemplates = savedTemplates.filter(t => t.id !== id); await setDoc(doc(db, "settings", "templates"), { list: savedTemplates }); renderTemplateTabs(); } };

window.loadCustomTemplate = (id) => {
    const t = savedTemplates.find(x => x.id === id); if(!t) return;
    document.getElementById('currentItemType').value = t.id; 
    document.querySelectorAll('.tab-btn').forEach(tb => tb.classList.remove('active')); document.getElementById(`tab-${id}`).classList.add('active');
    
    document.getElementById('moduleToolbar').style.display = 'flex';
    document.querySelectorAll('.mod-btn').forEach(b => b.classList.remove('added'));
    ['images','cast','desc','custom'].forEach(m => document.getElementById(`wrap-${m}`).style.display = 'none');
    
    t.activeMods.forEach(m => { document.getElementById(`wrap-${m}`).style.display = 'block'; document.getElementById(`btn-mod-${m}`).classList.add('added'); });
    
    document.getElementById('dynamicFieldsContainer').innerHTML = '';
    t.fields.forEach(f => window.addDynamicFieldRow(f.key, '', f.type));
};

// --- YEREL ÖNİZLEME (LOCAL PREVIEW) ---
window.handleLocalImageSelect = (e) => {
    const files = e.target.files; if (!files || files.length === 0) return;
    for(let i=0; i<files.length; i++) { pendingImageFiles.push(files[i]); }
    e.target.value = ''; 
    renderExistingImagesPreview();
};

const renderExistingImagesPreview = () => {
    const cont = document.getElementById('existingImagesPreview');
    cont.innerHTML = ''; 
    currentImagesArray.forEach((url, idx) => {
        cont.innerHTML += `<div class="img-box"><img src="${cldMini(url)}"><i class="fa-solid fa-circle-xmark del-icon" onclick="window.removeExistingImage(${idx})"></i></div>`;
    });
    pendingImageFiles.forEach((file, idx) => {
        const localUrl = URL.createObjectURL(file);
        cont.innerHTML += `<div class="img-box pending"><img src="${localUrl}"><i class="fa-solid fa-circle-xmark del-icon" style="color:#ffa500;" onclick="window.removePendingImage(${idx})" title="İptal Et"></i></div>`;
    });
};

window.removeExistingImage = (idx) => { currentImagesArray.splice(idx, 1); renderExistingImagesPreview(); };
window.removePendingImage = (idx) => { pendingImageFiles.splice(idx, 1); renderExistingImagesPreview(); };

// --- MODAL STATE SIFIRLAMA ---
const resetFormState = () => {
    document.getElementById('editId').value = '';
    document.getElementById('modalHeaderTitle').innerText = "Yeni Eser Ekle";
    document.getElementById('in-title').value = ''; document.getElementById('in-desc').value = ''; document.getElementById('in-file').value = '';
    
    document.getElementById('castAddBtn').innerText = "Ekle";
    document.getElementById('castAddBtn').removeAttribute('data-editing-id');
    document.getElementById('tempCastName').value = ''; document.getElementById('tempCastFile').value = ''; document.getElementById('tempCastImageUrl').value = '';
    document.getElementById('castExistingImgPreview').style.display = 'none';

    currentCastArray = []; currentImagesArray = []; pendingImageFiles = []; 
    renderCastChips(); renderExistingImagesPreview(); 
    document.getElementById('dynamicFieldsContainer').innerHTML = '';
};

window.openModal = () => {
    resetFormState();
    document.getElementById('addModal').classList.add('show'); document.getElementById('globalOverlay').classList.add('show');
    window.setFormType('film');
};

window.setFormType = (type) => {
    document.getElementById('currentItemType').value = type;
    document.querySelectorAll('.tab-btn').forEach(t => t.classList.remove('active')); 
    if(document.getElementById(`tab-${type}`)) document.getElementById(`tab-${type}`).classList.add('active');
    
    const tBar = document.getElementById('moduleToolbar'), wImg = document.getElementById('wrap-images'), wCast = document.getElementById('wrap-cast'), wDesc = document.getElementById('wrap-desc'), wCus = document.getElementById('wrap-custom');
    document.querySelectorAll('.mod-btn').forEach(b => b.classList.remove('added'));

    if (type === 'ozel') { tBar.style.display = 'flex'; wImg.style.display = 'none'; wCast.style.display = 'none'; wDesc.style.display = 'none'; wCus.style.display = 'none'; } 
    else { tBar.style.display = 'none'; wImg.style.display = 'block'; wDesc.style.display = 'block'; wCus.style.display = 'block'; if (type === 'ayrac') { wCast.style.display = 'none'; } else { wCast.style.display = 'block'; } }
    
    if(!document.getElementById('editId').value && type !== 'ozel' && !savedTemplates.some(t=>t.id===type)) { 
        document.getElementById('dynamicFieldsContainer').innerHTML = ''; 
        if(type === 'film') window.addDynamicFieldRow('IMDB Puanı', '', 'text'); 
        if(type === 'kitap') window.addDynamicFieldRow('Sayfa Sayısı', '', 'text'); 
    }
};

window.showModule = (wrapId, btnEl) => { document.getElementById(wrapId).style.display = 'block'; btnEl.classList.add('added'); };

// --- KİŞİ (CAST) SİSTEMİ ---
window.addCastMember = async () => {
    const name = document.getElementById('tempCastName').value.trim(), role = document.getElementById('tempCastRole').value, fileInput = document.getElementById('tempCastFile'), btn = document.getElementById('castAddBtn');
    const editingId = btn.getAttribute('data-editing-id'); const hiddenImg = document.getElementById('tempCastImageUrl').value;
    
    if(!name) return; 

    let imageUrl = hiddenImg; 
    let localFile = null;
    if (fileInput.files[0]) { 
        localFile = fileInput.files[0];
        imageUrl = URL.createObjectURL(localFile); 
    }

    if(editingId) {
        const idx = currentCastArray.findIndex(x => x.id === editingId);
        if(idx > -1) {
            currentCastArray[idx].name = name; currentCastArray[idx].role = role; currentCastArray[idx].imageUrl = imageUrl;
            if(localFile) currentCastArray[idx].localFile = localFile; 
        }
        btn.removeAttribute('data-editing-id');
    } else { 
        currentCastArray.push({ id: Date.now().toString(), name, role, imageUrl, localFile }); 
    }

    document.getElementById('tempCastName').value = ''; fileInput.value = ''; document.getElementById('tempCastImageUrl').value = ''; 
    document.getElementById('castExistingImgPreview').style.display = 'none';
    btn.innerText = "Ekle"; renderCastChips();
};

window.removeTempCastImg = () => { document.getElementById('tempCastImageUrl').value = ''; document.getElementById('castExistingImgPreview').style.display = 'none'; };

const renderCastChips = () => {
    document.getElementById('castChipsContainer').innerHTML = currentCastArray.map(c => `
        <div class="cast-chip">
            ${c.imageUrl ? `<img src="${c.imageUrl}">` : `<div style="width:30px;height:30px;border-radius:50%;background:#444;display:flex;align-items:center;justify-content:center;font-size:10px;">${c.name.substring(0,1)}</div>`}
            <div class="cast-chip-info"><span class="cast-chip-name">${c.name}</span><span class="cast-chip-role">${c.role}</span></div>
            <div class="cast-chip-actions"><i class="fa-solid fa-pen cast-chip-edit" onclick="window.editCast('${c.id}')"></i><i class="fa-solid fa-xmark cast-chip-del" onclick="window.removeCast('${c.id}')"></i></div>
        </div>`).join('');
};

window.editCast = (id) => {
    const c = currentCastArray.find(x => x.id === id); if(!c) return;
    document.getElementById('tempCastName').value = c.name; document.getElementById('tempCastRole').value = c.role; document.getElementById('tempCastImageUrl').value = c.imageUrl || '';
    if(c.imageUrl) { document.getElementById('castExistingImg').src = c.imageUrl; document.getElementById('castExistingImgPreview').style.display = 'block'; } else { document.getElementById('castExistingImgPreview').style.display = 'none'; }
    const btn = document.getElementById('castAddBtn'); btn.innerText = "Güncelle"; btn.setAttribute('data-editing-id', id);
};

window.removeCast = (id) => { currentCastArray = currentCastArray.filter(c => c.id !== id); renderCastChips(); };

// --- ÖZEL ALANLAR ---
window.addDynamicFieldRow = (key = '', val = '', type = 'text') => { 
    const cont = document.getElementById('dynamicFieldsContainer'); const row = document.createElement('div'); row.className = 'field-row'; row.dataset.type = type;
    if (type === 'text') {
        row.innerHTML = `<input type="text" placeholder="Özellik Adı" value="${key}" class="f-key"><input type="text" placeholder="Değer" value="${val}" class="f-val"><i class="fa-solid fa-trash-can remove-field-btn" onclick="this.parentElement.remove()"></i>`; 
    } else if (type === 'image') {
        let imgHtml = val ? `<div style="position:relative; width:35px; height:35px; margin-left:10px;"><img src="${val}" style="width:100%;height:100%;object-fit:cover;border-radius:4px;"><i class="fa-solid fa-circle-xmark" style="position:absolute;top:-5px;right:-5px;color:var(--danger-color);cursor:pointer;background:var(--bg-color);border-radius:50%;" onclick="this.parentElement.remove(); this.parentElement.parentElement.querySelector('.f-val-hidden').value='';"></i></div>` : '';
        row.innerHTML = `<input type="text" placeholder="Görselin Adı" value="${key}" class="f-key"><input type="file" accept="image/*" class="f-file" style="flex:1; padding:5px; font-size:11px;"><input type="hidden" class="f-val-hidden" value="${val}"><div class="f-img-preview">${imgHtml}</div><i class="fa-solid fa-trash-can remove-field-btn" onclick="this.parentElement.remove()"></i>`; 
    }
    cont.appendChild(row); 
};

// --- SİNEMATİK KAYIT MOTORU ---
window.saveItem = async () => {
    const id = document.getElementById('editId').value, title = document.getElementById('in-title').value;
    if(!title) { alert("Eser adı zorunlu!"); return; }

    const loader = document.getElementById('globalLoader');
    const loaderText = document.getElementById('loaderText');
    loader.classList.add('show');
    loaderText.innerText = "Güvenli bağlantı kuruluyor...";

    try {
        // 1. Bekleyen Ana Resimleri Yükle
        if (pendingImageFiles.length > 0) {
            loaderText.innerText = `Ana görseller buluta aktarılıyor (0/${pendingImageFiles.length})...`;
            const uploadedUrls = await Promise.all(pendingImageFiles.map(f => uploadImageToCloud(f)));
            currentImagesArray.push(...uploadedUrls);
        }

        // 2. Bekleyen Oyuncu/Kadro Resimlerini Yükle
        let hasCastImages = currentCastArray.some(c => c.localFile);
        if (hasCastImages) {
            loaderText.innerText = "Kişi/Kadro görselleri senkronize ediliyor...";
            for (let c of currentCastArray) {
                if (c.localFile) { c.imageUrl = await uploadImageToCloud(c.localFile); delete c.localFile; }
            }
        }

        // 3. Özel Alanlardaki Resimleri Bekle ve Yükle
        loaderText.innerText = "Özel veri alanları işleniyor...";
        const fields = []; 
        const rows = document.querySelectorAll('.field-row');
        const customFieldPromises = Array.from(rows).map(async (row) => {
            const type = row.dataset.type || 'text'; const key = row.querySelector('.f-key').value;
            if(type === 'text') { return { key, val: row.querySelector('.f-val').value, type: 'text' }; }
            else if(type === 'image') {
                const fileInput = row.querySelector('.f-file'); const hiddenVal = row.querySelector('.f-val-hidden').value;
                let finalUrl = hiddenVal;
                if(fileInput && fileInput.files.length > 0) { finalUrl = await uploadImageToCloud(fileInput.files[0]); }
                if(finalUrl || key) return { key, val: finalUrl, type: 'image' };
            }
            return null;
        });

        const resolvedFields = await Promise.all(customFieldPromises);
        resolvedFields.forEach(f => { if(f) fields.push(f); });

        // 4. Veritabanına Yaz
        loaderText.innerText = "Veritabanı güncelleniyor...";
        const data = {
            title: title, category: document.getElementById('in-cat').value, subCategory: document.getElementById('in-sub').value, subSubCategory: document.getElementById('in-sub-sub').value,
            description: document.getElementById('in-desc').value, itemType: document.getElementById('currentItemType').value,
            customFields: fields, cast: currentCastArray, timestamp: Date.now(), images: currentImagesArray
        };

        id ? await updateDoc(doc(db, "arsiv", id), data) : await addDoc(collection(db, "arsiv"), data);
        
        // 5. Başarılı Kapanış
        loaderText.innerText = "Mühürlendi! Arşive eklendi.";
        setTimeout(() => {
            loader.classList.remove('show');
            window.closeAll(); 
        }, 800);

    } catch(e) {
        console.error(e); 
        loaderText.innerText = "HATA: İşlem başarısız oldu!";
        setTimeout(() => { loader.classList.remove('show'); }, 2000);
    }
};

// --- DETAY PANELİ VE DÜZENLEME ---
// updateUrl=false: sadece geri/ileri (popstate) ya da sayfa ilk açılışındaki deep-link durumunda kullanılır,
// URL zaten doğru olduğu için tekrar history'e yazmaya gerek yoktur.
window.openDetail = (id, updateUrl = true) => {
    const item = allItems.find(i => i.id === id);
    if (!item) return; // deep-link ile gelinen id henüz veride yoksa veya silinmişse sessizce yok say
    activeId = id;
    const visual = document.getElementById('panelVisual'), thumbsCont = document.getElementById('galleryThumbnails');
    const coverUrl = (item.images && item.images.length > 0) ? item.images[0] : item.imageUrl;

    if(coverUrl) {
        visual.innerHTML = `<div class="img-container" style="height:450px;"><div class="img-blur" id="mainBlur" style="background-image:url('${cldBlur(coverUrl)}')"></div><img src="${cldFull(coverUrl)}" id="mainImg" class="img-front"></div>`;
        if(item.images && item.images.length > 1) { thumbsCont.style.display = 'flex'; thumbsCont.innerHTML = item.images.map(img => `<img src="${cldMini(img)}" data-full="${img}" class="thumb-img" onclick="window.changeMainImg('${img}', this)">`).join(''); } else { thumbsCont.style.display = 'none'; }
    } else { visual.innerHTML = `<div class="text-cover" style="height:400px; font-size:80px;">${item.title.substring(0,2).toUpperCase()}</div>`; thumbsCont.style.display = 'none'; }

    document.getElementById('p-title').innerText = item.title; document.getElementById('p-desc').innerText = item.description || '';
    const badges = document.getElementById('p-badges'); 
    let catStr = item.category; if(item.subCategory) catStr += ' / ' + item.subCategory; if(item.subSubCategory) catStr += ' / ' + item.subSubCategory;
    badges.innerHTML = `<span class="badge"><b>KATEGORİ:</b> ${catStr}</span>`;
    if(item.customFields) item.customFields.forEach(f => { 
        if(f.val) {
            if(f.type === 'image') badges.innerHTML += `<span class="badge" style="display:inline-flex; align-items:center; gap:5px; padding:4px 10px;"><b>${f.key.toUpperCase()}:</b> <a href="${f.val}" target="_blank"><img src="${f.val}" style="width:20px;height:20px;object-fit:cover;border-radius:4px;cursor:pointer;"></a></span>`;
            else badges.innerHTML += `<span class="badge"><b>${f.key.toUpperCase()}:</b> ${f.val}</span>`; 
        }
    });

    const castCont = document.getElementById('p-cast');
    if(item.cast && item.cast.length > 0) { castCont.style.display = 'flex'; castCont.innerHTML = item.cast.map(c => `<div class="p-cast-card">${c.imageUrl ? `<img src="${c.imageUrl}">` : `<div style="width:45px;height:45px;border-radius:50%;background:#333;display:flex;align-items:center;justify-content:center;color:white;">${c.name.substring(0,1)}</div>`}<div><div style="font-size:13px; font-weight:bold;">${c.name}</div><div style="font-size:11px; color:var(--accent-color);">${c.role}</div></div></div>`).join(''); } else { castCont.style.display = 'none'; }
    document.getElementById('detailPanel').classList.add('open'); document.getElementById('globalOverlay').classList.add('show');

    if (updateUrl) {
        const url = new URL(window.location);
        url.searchParams.set('item', id);
        history.pushState({ itemId: id }, '', url);
    }
};

window.changeMainImg = (url, el) => { document.getElementById('mainImg').src = cldFull(url); document.getElementById('mainBlur').style.backgroundImage = `url('${cldBlur(url)}')`; document.querySelectorAll('.thumb-img').forEach(i => i.classList.remove('active')); el.classList.add('active'); };

window.editCurrentItem = () => {
    const item = allItems.find(i => i.id === activeId); resetFormState(); document.getElementById('editId').value = item.id;
    document.getElementById('modalHeaderTitle').innerText = "Eseri Düzenle";
    document.getElementById('in-title').value = item.title; 
    document.getElementById('in-cat').value = item.category; window.updateSubSelect(); 
    document.getElementById('in-sub').value = item.subCategory || ''; window.updateSubSubSelect();
    document.getElementById('in-sub-sub').value = item.subSubCategory || '';
    document.getElementById('in-desc').value = item.description || '';
    
    // Eğer JSON'dan eski localFile (hatalı veri) kalmışsa temizleyelim ki bug yapmasın
    currentCastArray = (item.cast || []).map(c => { delete c.localFile; return c; }); 
    renderCastChips(); 
    
    currentImagesArray = item.images || (item.imageUrl ? [item.imageUrl] : []); renderExistingImagesPreview();
    
    document.getElementById('dynamicFieldsContainer').innerHTML = ''; if(item.customFields) item.customFields.forEach(f => window.addDynamicFieldRow(f.key, f.val, f.type));

    const type = item.itemType || 'ozel';
    if(['film','kitap','ayrac','ozel'].includes(type) || savedTemplates.some(t=>t.id===type)) window.setFormType(type); else window.setFormType('ozel');
    
    if (type === 'ozel' || savedTemplates.some(t=>t.id===type)) {
        if (currentImagesArray.length > 0) window.showModule('wrap-images', document.getElementById('btn-mod-images'));
        if (currentCastArray.length > 0) window.showModule('wrap-cast', document.getElementById('btn-mod-cast'));
        if (item.description) window.showModule('wrap-desc', document.getElementById('btn-mod-desc'));
        if (item.customFields && item.customFields.length > 0) window.showModule('wrap-custom', document.getElementById('btn-mod-custom'));
    }
    document.getElementById('detailPanel').classList.remove('open'); document.getElementById('addModal').classList.add('show');
};

window.deleteCurrentItem = async () => { if(confirm("Bu eseri silmek istediğine emin misin?")) { await deleteDoc(doc(db, "arsiv", activeId)); window.closeAll(); } };

// updateUrl=false: geri tuşuyla (popstate) tetiklendiğinde URL zaten güncel olduğundan tekrar dokunmuyoruz.
window.closeAll = (updateUrl = true) => { 
    resetFormState(); 
    document.querySelectorAll('.modal').forEach(m => m.classList.remove('show')); 
    document.getElementById('detailPanel').classList.remove('open'); 
    document.getElementById('globalOverlay').classList.remove('show'); 
    document.getElementById('sidebar')?.classList.remove('mobile-open');
    activeId = null;

    if (updateUrl && new URLSearchParams(location.search).has('item')) {
        const url = new URL(window.location);
        url.searchParams.delete('item');
        history.pushState({}, '', url);
    }
};

// --- DEEP LINK: URL'deki ?item=ID'yi dinle (geri/ileri tuşları + ilk açılış) ---
let deepLinkChecked = false;
const checkDeepLink = () => {
    const id = new URLSearchParams(location.search).get('item');
    if (id) { window.openDetail(id, false); }
};

window.addEventListener('popstate', () => {
    const id = new URLSearchParams(location.search).get('item');
    if (id) window.openDetail(id, false); else window.closeAll(false);
});

const updateInCatSelect = () => { const s = document.getElementById('in-cat'); s.innerHTML = categoryTree.map(c => `<option value="${c.name}">${c.name}</option>`).join(''); window.updateSubSelect(); };
window.updateSubSelect = () => { const val = document.getElementById('in-cat').value; const sub = document.getElementById('in-sub'); const cat = categoryTree.find(c => c.name === val); sub.innerHTML = '<option value="">-- Yok --</option>' + (cat ? (cat.sub||[]).map(s => `<option value="${s.name}">${s.name}</option>`).join('') : ''); window.updateSubSubSelect(); };
window.updateSubSubSelect = () => { const mVal = document.getElementById('in-cat').value; const sVal = document.getElementById('in-sub').value; const ss = document.getElementById('in-sub-sub'); const mCat = categoryTree.find(c => c.name === mVal); const sCat = mCat ? (mCat.sub||[]).find(s => s.name === sVal) : null; ss.innerHTML = '<option value="">-- Yok --</option>' + (sCat ? (sCat.sub||[]).map(x => `<option value="${x.name}">${x.name}</option>`).join('') : ''); };

// --- KATEGORİ YÖNETİMİ ---
window.openCatManager = () => { renderCatMan(); document.getElementById('catModal').classList.add('show'); document.getElementById('globalOverlay').classList.add('show'); };
const renderCatMan = () => {
    document.getElementById('catManList').innerHTML = categoryTree.map(c => `
        <div style="background:var(--bg-color); border:1px solid var(--border-color); border-radius:12px; padding:15px; margin-bottom:12px;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;"><b style="font-size:14px; color:white; display:flex; align-items:center; gap:8px;">${c.iconUrl ? `<img src="${c.iconUrl}" style="width:20px;height:20px;object-fit:contain;">` : ''} ${c.name}</b><div class="admin-only"><button class="action-icon-btn" onclick="window.openEditCatModal('${c.id}', null, null)" title="Düzenle"><i class="fa-solid fa-pen"></i></button><button class="action-icon-btn" onclick="window.openEditCatModal('${c.id}', 'NEW_SUB', null)"><i class="fa-solid fa-plus"></i> Alt Ekle</button><button class="action-icon-btn" style="color:var(--danger-color);" onclick="window.delCat('${c.id}', null, null)"><i class="fa-solid fa-trash"></i></button></div></div>
            ${(c.sub||[]).map(s => `
                <div style="margin-left:15px; border-left:2px solid var(--border-color); padding-left:10px; margin-bottom:5px;">
                    <div style="display:flex; justify-content:space-between; align-items:center; background:var(--sidebar-bg); padding:6px 10px; border-radius:8px; margin-bottom:2px;"><span style="font-size:12px; color:var(--text-muted); display:flex; align-items:center; gap:8px;">↳ ${s.iconUrl ? `<img src="${s.iconUrl}" style="width:16px;height:16px;object-fit:contain;">` : ''} ${s.name}</span><div class="admin-only"><button class="action-icon-btn" onclick="window.openEditCatModal('${c.id}', '${s.id}', null)" title="Düzenle"><i class="fa-solid fa-pen"></i></button><button class="action-icon-btn" onclick="window.openEditCatModal('${c.id}', '${s.id}', 'NEW_SUB_SUB')"><i class="fa-solid fa-plus"></i> Alt Ekle</button><button class="action-icon-btn" style="color:var(--danger-color);" onclick="window.delCat('${c.id}', '${s.id}', null)"><i class="fa-solid fa-xmark"></i></button></div></div>
                    ${(s.sub||[]).map(ss => `
                        <div style="margin-left:20px; display:flex; justify-content:space-between; align-items:center; background:#111; padding:4px 10px; border-radius:6px; margin-bottom:2px;"><span style="font-size:11px; color:#777; display:flex; align-items:center; gap:8px;">- ${ss.iconUrl ? `<img src="${ss.iconUrl}" style="width:12px;height:12px;object-fit:contain;">` : ''} ${ss.name}</span><div class="admin-only"><button class="action-icon-btn" onclick="window.openEditCatModal('${c.id}', '${s.id}', '${ss.id}')" title="Düzenle"><i class="fa-solid fa-pen"></i></button><button class="action-icon-btn" style="color:var(--danger-color);" onclick="window.delCat('${c.id}', '${s.id}', '${ss.id}')"><i class="fa-solid fa-xmark"></i></button></div></div>
                    `).join('')}
                </div>`).join('')}
        </div>`).join('');
    if (auth.currentUser) {
        document.querySelectorAll('#catManList .admin-only').forEach(el => el.style.display = 'flex');
    }
};

window.openEditCatModal = (mId, sId, ssId) => {
    document.getElementById('ec-mId').value = mId || ''; document.getElementById('ec-sId').value = sId || ''; document.getElementById('ec-ssId').value = ssId || '';
    document.getElementById('ec-name').value = ''; document.getElementById('ec-icon').value = '';
    
    let title = "Yeni Kategori Ekle";
    if(mId && !sId && !ssId) { const c = categoryTree.find(x=>x.id===mId); title = "Ana Kategori Düzenle"; document.getElementById('ec-name').value = c.name; }
    else if(mId && sId && sId !== 'NEW_SUB' && !ssId) { const c = categoryTree.find(x=>x.id===mId).sub.find(x=>x.id===sId); title = "Alt Kategori Düzenle"; document.getElementById('ec-name').value = c.name; }
    else if(mId && sId && ssId && ssId !== 'NEW_SUB_SUB') { const c = categoryTree.find(x=>x.id===mId).sub.find(x=>x.id===sId).sub.find(x=>x.id===ssId); title = "3. Seviye Kategori Düzenle"; document.getElementById('ec-name').value = c.name; }
    else if(sId === 'NEW_SUB') title = "Alt Kategori Ekle";
    else if(ssId === 'NEW_SUB_SUB') title = "3. Seviye Alt Kategori Ekle";
    
    document.getElementById('editCatTitle').innerText = title; document.getElementById('editCatModal').classList.add('show');
};

window.closeEditCatModal = () => document.getElementById('editCatModal').classList.remove('show');

window.saveEditCat = async () => {
    const mId = document.getElementById('ec-mId').value, sId = document.getElementById('ec-sId').value, ssId = document.getElementById('ec-ssId').value;
    const name = document.getElementById('ec-name').value.trim(); const file = document.getElementById('ec-icon').files[0];
    if(!name) return;
    const btn = document.getElementById('saveEditCatBtn'); btn.innerText = "Yükleniyor..."; btn.disabled = true;
    let iconUrl = ""; if(file) { try { iconUrl = await uploadImageToCloud(file); } catch(e){} }
    
    if(!mId) { categoryTree.push({id: Date.now().toString(), name, sub: [], iconUrl}); } 
    else if(mId && !sId) { const c = categoryTree.find(x=>x.id===mId); c.name = name; if(iconUrl) c.iconUrl = iconUrl; } 
    else if(mId && sId === 'NEW_SUB') { categoryTree.find(x=>x.id===mId).sub.push({id: Date.now().toString(), name, sub: [], iconUrl}); } 
    else if(mId && sId && !ssId) { const c = categoryTree.find(x=>x.id===mId).sub.find(x=>x.id===sId); c.name = name; if(iconUrl) c.iconUrl = iconUrl; } 
    else if(mId && sId && ssId === 'NEW_SUB_SUB') { categoryTree.find(x=>x.id===mId).sub.find(x=>x.id===sId).sub = categoryTree.find(x=>x.id===mId).sub.find(x=>x.id===sId).sub || []; categoryTree.find(x=>x.id===mId).sub.find(x=>x.id===sId).sub.push({id: Date.now().toString(), name, iconUrl}); } 
    else if(mId && sId && ssId) { const c = categoryTree.find(x=>x.id===mId).sub.find(x=>x.id===sId).sub.find(x=>x.id===ssId); c.name = name; if(iconUrl) c.iconUrl = iconUrl; } 
    
    await saveTree(); window.closeEditCatModal(); btn.innerText = "Kaydet"; btn.disabled = false;
};

window.delCat = async (mId, sId, ssId) => {
    if(confirm('Silinecek. Emin misin?')) {
        if(!sId) { categoryTree = categoryTree.filter(c => c.id !== mId); }
        else if(sId && !ssId) { const m = categoryTree.find(c => c.id === mId); m.sub = m.sub.filter(s => s.id !== sId); }
        else if(sId && ssId) { const s = categoryTree.find(c => c.id === mId).sub.find(x=>x.id===sId); s.sub = s.sub.filter(x => x.id !== ssId); }
        await saveTree();
    }
};

const saveTree = async () => { await setDoc(doc(db, "settings", "categories"), { tree: categoryTree }); renderSidebar(); renderCatMan(); updateInCatSelect(); };
const saveTreeSilent = async () => { await setDoc(doc(db, "settings", "categories"), { tree: categoryTree }); updateInCatSelect(); renderCatMan(); };

loadSystemData(); loadData();

// --- NETFLIX DRAG TO SCROLL ---
window.isDraggingCard = false;
let isDown = false, startX, scrollLeft, slider = null;
document.addEventListener('mousedown', (e) => { slider = e.target.closest('.netflix-scroll'); if(!slider) return; isDown = true; slider.classList.add('active'); startX = e.pageX - slider.offsetLeft; scrollLeft = slider.scrollLeft; window.isDraggingCard = false; });
document.addEventListener('mouseleave', () => { isDown = false; if(slider) slider.classList.remove('active'); });
document.addEventListener('mouseup', () => { isDown = false; if(slider) slider.classList.remove('active'); setTimeout(() => { window.isDraggingCard = false; }, 0); });
document.addEventListener('mousemove', (e) => { if(!isDown || !slider) return; e.preventDefault(); const x = e.pageX - slider.offsetLeft; const walk = (x - startX) * 2; if (Math.abs(walk) > 5) window.isDraggingCard = true; slider.scrollLeft = scrollLeft - walk; });

// --- CUSTOM TAILORED TURKISH EMOJI PICKER ---
const emojiCategories = {
  smileys: {
    icon: '😊',
    name: 'Yüzler & Duygular',
    emojis: [
      { char: '😀', keywords: 'gülen neşeli mutlu sırıtan smiley' },
      { char: '😃', keywords: 'gülen mutlu neşeli gözleri açık' },
      { char: '😄', keywords: 'gülen mutlu ağzı açık gözleri kısık' },
      { char: '😁', keywords: 'sırıtan dişlerini gösteren mutlu' },
      { char: '😆', keywords: 'kahkaha gülen gözleri kapalı' },
      { char: '😅', keywords: 'soğuk ter döken gülen rahatlamış' },
      { char: '😂', keywords: 'gülmekten ağlayan komik kahkaha' },
      { char: '🤣', keywords: 'yerde yuvarlanarak gülen çok komik' },
      { char: '😊', keywords: 'utangaç gülen yanakları kızarmış mutlu' },
      { char: '😇', keywords: 'melek masum iyi' },
      { char: '🙂', keywords: 'hafif gülen sakin' },
      { char: '🙃', keywords: 'baş aşağı dönmüş şaka espri' },
      { char: '😉', keywords: 'göz kırpan muzip şakacı' },
      { char: '😌', keywords: 'rahatlamış huzurlu sakin' },
      { char: '😍', keywords: 'gözleri kalpli aşık sevgi beğeni' },
      { char: '🥰', keywords: 'kalplerle çevrili aşık sevgi dolu' },
      { char: '😘', keywords: 'öpücük gönderen aşk sevgi' },
      { char: '😋', keywords: 'dili dışarıda lezzetli leziz şaka' },
      { char: '😛', keywords: 'dil çıkaran muzip şaka' },
      { char: '😜', keywords: 'göz kırpıp dil çıkaran muzip' },
      { char: '🤪', keywords: 'çılgın deli komik' },
      { char: '😝', keywords: 'gözleri kapalı dil çıkaran şaka' },
      { char: '🤑', keywords: 'para gözlü zengin dolar' },
      { char: '🤗', keywords: 'sarılmak kucaklaşmak dost' },
      { char: '🤭', keywords: 'elini ağzına götüren kıkırdayan sır' },
      { char: '🤫', keywords: 'sus sessiz şşşt sakin' },
      { char: '🤔', keywords: 'düşünen akıl fikir soru' },
      { char: '🤐', keywords: 'ağzı fermuarlı sessiz sır' },
      { char: '🤨', keywords: 'tek kaşı kalkmış şüphe sorgulama' },
      { char: '😐', keywords: 'nötr ifadesiz tepkisiz' },
      { char: '😑', keywords: 'ifadesiz ciddi memnuniyetsiz' },
      { char: '😶', keywords: 'ağızsız sessiz şaşkın' },
      { char: '😏', keywords: 'alaycı gülen kendinden emin havalı' },
      { char: '😒', keywords: 'memnuniyetsiz sıkılmış somurtan' },
      { char: '🙄', keywords: 'gözlerini deviren bıkkın sıkılmış' },
      { char: '😬', keywords: 'dişlerini sıkan gergin endişeli' },
      { char: '🤥', keywords: 'burnu uzamış yalancı yalan pinokyo' },
      { char: '😔', keywords: 'üzgün dalgın düşünceli somurtkan' },
      { char: '😪', keywords: 'uykulu yorgun sümük salyalı' },
      { char: '🤤', keywords: 'ağzının suyu akan iştahlı hayran' },
      { char: '😴', keywords: 'uyuyan horlayan zzz' },
      { char: '😷', keywords: 'maskeli hasta korona' },
      { char: '🤒', keywords: 'dereceli ateşli hasta' },
      { char: '🤕', keywords: 'kafası sarılı yaralı kazalı' },
      { char: '🤢', keywords: 'midesi bulanan iğrenen yeşil' },
      { char: '🤮', keywords: 'kuskan iğrenç hasta' },
      { char: '🤧', keywords: 'hapşıran mendilli nezle grip' },
      { char: '🥵', keywords: 'sıcaklamış terlemiş kırmızı' },
      { char: '🥶', keywords: 'üşümüş donmuş mavi buz' },
      { char: '🥴', keywords: 'sarhoş başı dönmüş sersem' },
      { char: '😵', keywords: 'gözleri çarpı olmuş ölü baygın' },
      { char: '🤯', keywords: 'kafası patlamış şaşkın şok' },
      { char: '🤠', keywords: 'kovboy şapkalı macera' },
      { char: '🥳', keywords: 'parti kutlama şapkalı eğlence' },
      { char: '😎', keywords: 'havalı güneş gözlüklü tarz karizma' },
      { char: '🤓', keywords: 'gözlüklü inek dahi zeki bilgin' },
      { char: '🧐', keywords: 'monokllü inceleyen dedektif' },
      { char: '😕', keywords: 'kafası karışık kararsız' },
      { char: '😟', keywords: 'endişeli üzgün' },
      { char: '🙁', keywords: 'hafif somurtan üzgün' },
      { char: '☹️', keywords: 'somurtan üzgün' },
      { char: '😮', keywords: 'ağzı açık şaşırmış şok' },
      { char: '😯', keywords: 'sessiz şaşkın şok' },
      { char: '😲', keywords: 'çok şaşırmış şok hayret' },
      { char: '😳', keywords: 'utanmış gözleri büyümüş kızarmış' },
      { char: '🥺', keywords: 'yalvaran gözler kıyamam masum duyusal' },
      { char: '😦', keywords: 'endişeli şaşkın ağzı açık' },
      { char: '😧', keywords: 'korkmuş şaşkın' },
      { char: '😨', keywords: 'korkmuş endişeli tırsmış' },
      { char: '😰', keywords: 'soğuk ter döken endişeli korkmuş' },
      { char: '😥', keywords: 'üzgün ama rahatlamış terli' },
      { char: '😢', keywords: 'ağlayan üzgün gözü yaşlı' },
      { char: '😭', keywords: 'hıçkıra hıçkıra ağlayan çok üzgün' },
      { char: '😱', keywords: 'korkudan çığlık atan çığlık şok' },
      { char: '😖', keywords: 'acı çeken rahatsız gergin' },
      { char: '😣', keywords: 'zorlanan çabalayan sabreden' },
      { char: '😞', keywords: 'hayal kırıklığına uğramış üzgün' },
      { char: '😓', keywords: 'soğuk terli üzgün stresli' },
      { char: '😩', keywords: 'tükenmiş bıkmış yorulmuş' },
      { char: '😫', keywords: 'yorgun bıkkın yıpranmış' },
      { char: '🥱', keywords: 'esneyen uykulu' },
      { char: '😤', keywords: 'burnundan soluyan öfkeli gururlu' },
      { char: '😡', keywords: 'kızgın öfkeli kırmızı sinirli' },
      { char: '😠', keywords: 'kızgın sinirli somurtan' },
      { char: '🤬', keywords: 'küfreden ağzı sansürlü çok kızgın' },
      { char: '😈', keywords: 'şeytani gülen mor yaramaz' },
      { char: '👿', keywords: 'şeytan sinirli mor kızgın' },
      { char: '💀', keywords: 'kurukafa ölüm tehlike korsan' },
      { char: '☠️', keywords: 'korsan ölüm tehlike' },
      { char: '💩', keywords: 'kaka pislik sevimli komik' },
      { char: '🤡', keywords: 'palyaço komik şaka' },
      { char: '👻', keywords: 'hayalet korku sevimli' },
      { char: '👽', keywords: 'uzaylı yabancı' },
      { char: '🤖', keywords: 'robot yapay zeka teknoloji' }
    ]
  },
  animals: {
    icon: '🐱',
    name: 'Hayvanlar & Doğa',
    emojis: [
      { char: '🐶', keywords: 'köpek enik sadık' },
      { char: '🐱', keywords: 'kedi miyav pisi' },
      { char: '🐭', keywords: 'fare kemirgen mini' },
      { char: '🐹', keywords: 'hamster sevimli' },
      { char: '🐰', keywords: 'tavşan havuç hızlı' },
      { char: '🦊', keywords: 'tilki kurnaz turuncu' },
      { char: '🐻', keywords: 'ayı kahverengi orman' },
      { char: '🐼', keywords: 'panda bambu siyah beyaz' },
      { char: '🐨', keywords: 'koala okaliptüs uykulu' },
      { char: '🐯', keywords: 'kaplan vahşi çizgili' },
      { char: '🦁', keywords: 'aslan kral vahşi' },
      { char: '🐮', keywords: 'inek süt boğa' },
      { char: '🐷', keywords: 'domuz pembe sevimli' },
      { char: '🐸', keywords: 'kurbağa yeşil göl vırak' },
      { char: '🐵', keywords: 'maymun muz komik' },
      { char: '🐔', keywords: 'tavuk gıdak kümes' },
      { char: '🐧', keywords: 'penguen kutup buz soğuk' },
      { char: '🐦', keywords: 'kuş kanat ötücü' },
      { char: '🐤', keywords: 'civciv sarı küçük' },
      { char: '🦆', keywords: 'ördek vak göl' },
      { char: '🦅', keywords: 'kartal yırtıcı uçan' },
      { char: '🦉', keywords: 'baykuş gece zeki bilge' },
      { char: '🐺', keywords: 'kurt vahşi uluyan' },
      { char: '🐴', keywords: 'at nal koşan yele' },
      { char: '🦄', keywords: 'tek boynuzlu at masal büyü' },
      { char: '🐝', keywords: 'arı bal vız sokan' },
      { char: '🦋', keywords: 'kelebek renkli kanat' },
      { char: '🐌', keywords: 'salyangoz yavaş kabuklu' },
      { char: '🐞', keywords: 'uğur böceği benekli kırmızı şans' },
      { char: '🐜', keywords: 'karınca çalışkan küçük' },
      { char: '🕸️', keywords: 'örümcek ağı sekiz bacak' },
      { char: '🐢', keywords: 'kaplumbağa yavaş kabuk yeşil' },
      { char: '蛇', keywords: 'yılan zehirli tıslayan' },
      { char: '🐙', keywords: 'ahtapot deniz vantuz kollu' },
      { char: '🐠', keywords: 'tropikal balık akvaryum renkli' },
      { char: '🐟', keywords: 'balık deniz göl olta' },
      { char: '🐬', keywords: 'yunus zeki deniz memeli' },
      { char: '🐳', keywords: 'balina dev su fışkırtan' },
      { char: '🦈', keywords: 'köpekbalığı yırtıcı dişli deniz' },
      { char: '🐊', keywords: 'timsah nehir yırtıcı sürüngen' },
      { char: '🐘', keywords: 'fil hortum dev gri' },
      { char: '🦒', keywords: 'zürafa uzun boyun afrika' },
      { char: '🕊️', keywords: 'güvercin barış beyaz kanat' },
      { char: '🐾', keywords: 'pati izi ayak izi köpek kedi' },
      { char: '🌵', keywords: 'kaktüs çöl dikenli yeşil' },
      { char: '🎄', keywords: 'yılbaşı ağacı çam süslü noel' },
      { char: '🌲', keywords: 'çam ağacı orman doğa' },
      { char: '🌳', keywords: 'ağaç yapraklı doğa park' },
      { char: '🌴', keywords: 'palmiye yaz plaj ada sıcak' },
      { char: '🌱', keywords: 'filiz yaprak bitki yeni başlangıç' },
      { char: '🍀', keywords: 'dört yapraklı yonca şans yeşil' },
      { char: '🍁', keywords: 'akçaağaç yaprağı sonbahar kırmızı kanada' },
      { char: '🍂', keywords: 'dökülmüş yapraklar sonbahar kuru' },
      { char: '🌸', keywords: 'kiraz çiçeği sakura pembe bahar' },
      { char: '🌹', keywords: 'gül kırmızı çiçek aşk sevgi' },
      { char: '🌻', keywords: 'ayçiçeği günebakın sarı yaz' },
      { char: '🌼', keywords: 'papatya sarı beyaz çiçek' },
      { char: '🌷', keywords: 'lale bahar çiçek renkli' },
      { char: '🍄', keywords: 'mantar orman zehirli kırmızı' },
      { char: '🌾', keywords: 'pirinç başağı buğday tarım ekin' },
      { char: '💐', keywords: 'çiçek buketi hediye tebrik kutlama' },
      { char: '☀️', keywords: 'güneş sıcak parlak hava yaz' },
      { char: '🌙', keywords: 'hilal ay gece gökyüzü islam' },
      { char: '☁️', keywords: 'bulut hava gökyüzü kapalı' },
      { char: '🌧️', keywords: 'yağmurlu bulut damla hava' },
      { char: '⚡', keywords: 'şimşek yıldırım elektrik güç hızlı' },
      { char: '🔥', keywords: 'ateş alev sıcak yanıyor süper popüler' },
      { char: '❄️', keywords: 'kar tanesi kış soğuk buz' },
      { char: '🌊', keywords: 'dalga tsunami deniz okyanus su' }
    ]
  },
  food: {
    icon: '🍔',
    name: 'Yiyecek & İçecek',
    emojis: [
      { char: '🍏', keywords: 'yeşil elma meyve taze ekşi' },
      { char: '🍎', keywords: 'kırmızı elma meyve tatlı' },
      { char: '🍐', keywords: 'armut meyve yeşil' },
      { char: '🍊', keywords: 'mandalina portakal narenciye vitamin' },
      { char: '🍋', keywords: 'limon ekşi sarı vitamin' },
      { char: '🍌', keywords: 'muz sarı meyve' },
      { char: '🍉', keywords: 'karpuz yaz meyvesi kırmızı' },
      { char: '🍇', keywords: 'üzüm mor meyve asma' },
      { char: '🍓', keywords: 'çilek kırmızı lezzetli meyve' },
      { char: '🍒', keywords: 'kiraz vişne kırmızı meyve' },
      { char: '🍍', keywords: 'ananas tropikal dikenli meyve' },
      { char: '🍅', keywords: 'domates kırmızı sebze salata' },
      { char: '🍆', keywords: 'patlıcan mor sebze' },
      { char: '🥑', keywords: 'avokado yeşil sağlıklı yağ' },
      { char: '🌽', keywords: 'mısır sarı közlenmiş koçan' },
      { char: '🥕', keywords: 'havuç turuncu tavşan sebze' },
      { char: '🥔', keywords: 'patates kızartma kumpir' },
      { char: '🍞', keywords: 'ekmek fırın somun un buğday' },
      { char: '🥐', keywords: 'kruvasan kahvaltı tereyağlı' },
      { char: '🧀', keywords: 'peynir sarı delikli kahvaltı' },
      { char: '🍖', keywords: 'kemikli et mangal ızgara' },
      { char: '🍗', keywords: 'tavuk budu kızarmış baget' },
      { char: '🍔', keywords: 'hamburger fast food ekmek et köfte' },
      { char: '🍟', keywords: 'patates kızartması fast food tuzlu patates' },
      { char: '🍕', keywords: 'pizza İtalyan fast food peynirli sucuklu' },
      { char: '🌭', keywords: 'sosisli sandviç hot dog fast food' },
      { char: '🍳', keywords: 'tavada yumurta omlet kahvaltı pişirme' },
      { char: '🍿', keywords: 'patlamış mısır sinema film dizi keyif mısır' },
      { char: '🍣', keywords: 'suşi japon balık pilav yosun' },
      { char: '🍦', keywords: 'külah dondurma tatlı soğuk yaz' },
      { char: '🍩', keywords: 'donut çörek tatlı delikli çikolata' },
      { char: '🍪', keywords: 'kurabiye çikolata parçacıklı bisküvi' },
      { char: '🎂', keywords: 'doğum günü pastası mumlu pasta kutlama' },
      { char: '🍰', keywords: 'dilim pasta çilekli tatlı fırın' },
      { char: '🍫', keywords: 'çikolata kakao tatlı şekerleme bitter' },
      { char: '🍬', keywords: 'şeker paketli tatlı şekerleme' },
      { char: '☕', keywords: 'kahve çay sıcak içecek kupa espresso' },
      { char: '🍵', keywords: 'yeşil çay bitki çayı kupa sıcak' },
      { char: '🍺', keywords: 'bira bardak alkol bar içki' },
      { char: '🍻', keywords: 'bira bardakları tokuşturma şerefe' },
      { char: '🍷', keywords: 'kadeh kırmızı şarap alkol bar içki' },
      { char: '🥃', keywords: 'viski bardağı alkol bar içki' },
      { char: '🍹', keywords: 'tropikal kokteyl pipetli meyve suyu yaz' },
      { char: '🥤', keywords: 'pipetli bardak kola gazoz içecek soğuk' }
    ]
  },
  travel: {
    icon: '🚗',
    name: 'Seyahat & Yerler',
    emojis: [
      { char: '🚗', keywords: 'araba kırmızı otomobil binek araç' },
      { char: '🚕', keywords: 'taksi sarı araç ulaşım' },
      { char: '🚙', keywords: 'cip mavi arazi aracı araba' },
      { char: '🚌', keywords: 'otobüs sarı toplu taşıma yolculuk' },
      { char: '🏎️', keywords: 'yarış arabası formula f1 hızlı' },
      { char: '🚓', keywords: 'polis arabası siren araç güvenlik' },
      { char: '🚑', keywords: 'ambulans hasta hastane acil ilk yardım' },
      { char: '🚒', keywords: 'itfaiye arabası yangın acil kırmızı' },
      { char: '🚚', keywords: 'kamyon nakliye kargo lojistik' },
      { char: '🚜', keywords: 'traktör tarım tarla çiftlik yeşil' },
      { char: '🚲', keywords: 'bisiklet pedal iki teker spor ulaşım' },
      { char: '🛵', keywords: 'motosiklet scooter kurye paket ulaşım' },
      { char: '🚨', keywords: 'polis sireni kırmızı mavi ışık acil alarm' },
      { char: '✈️', keywords: 'uçak uçuş seyahat havaalanı havayolu tatil' },
      { char: '🚀', keywords: 'roket uzay fırlatma uçuş hızlı' },
      { char: '🚁', keywords: 'helikopter hava uçuş pervaneli' },
      { char: '⛵', keywords: 'yelkenli tekne deniz rüzgar tatil' },
      { char: '🚢', keywords: 'gemi dev yolcu gemisi deniz okyanus' },
      { char: '🚆', keywords: 'hızlı tren ray metro ulaşım' },
      { char: '🗺️', keywords: 'dünya haritası atlas seyahat konum keşif' },
      { char: '🏔️', keywords: 'karlı dağ zirve doğa kış manzara' },
      { char: '🌋', keywords: 'yanardağ volkan lav patlama ateş' },
      { char: '🏕️', keywords: 'kamp çadır doğa orman tatil macera' },
      { char: '🏖️', keywords: 'plaj şemsiyeli kum deniz güneş tatil yaz' },
      { char: '🏙️', keywords: 'şehir silüeti gökdelenler binalar metropol' },
      { char: '🏰', keywords: 'şato kale masal kral prenses' },
      { char: '🏠', keywords: 'ev konut yuva bina çatı' },
      { char: '🏢', keywords: 'ofis binası işyeri plaza gökdelen' },
      { char: '🏥', keywords: 'hastane doktor tıp acil bina' },
      { char: '🏦', keywords: 'banka para finans bina dolar euro' },
      { char: '🏨', keywords: 'otel konaklama seyahat tatil bina' },
      { char: '🏫', keywords: 'okul sınıf eğitim öğrenci öğretmen' },
      { char: '🕌', keywords: 'cami islam din ibadet minare kubbe' },
      { char: '⛺', keywords: 'çadır kamp' }
    ]
  },
  objects: {
    icon: '💡',
    name: 'Objeler & Semboller',
    emojis: [
      { char: '👓', keywords: 'gözlük görme çerçeve aksesuar' },
      { char: '🕶️', keywords: 'güneş gözlüğü havalı yaz tarz izleme' },
      { char: '💼', keywords: 'evrak çantası iş dosya memur toplantı' },
      { char: '🎒', keywords: 'sırt çantası okul öğrenci seyahat kamp' },
      { char: '👑', keywords: 'kral tacı kraliçe altın iktidar lider' },
      { char: '💍', keywords: 'yüzük pırlanta elmas evlilik nişan aşk' },
      { char: '💎', keywords: 'elmas mücevher pırlanta değerli taş' },
      { char: '📱', keywords: 'akıllı telefon cep telefonu mobil teknoloji' },
      { char: '💻', keywords: 'dizüstü bilgisayar laptop bilgisayar yazılım' },
      { char: '📺', keywords: 'televizyon ekran dizi film yayın kutu' },
      { char: '📷', keywords: 'fotoğraf makinesi kamera mercek çekim' },
      { char: '📼', keywords: 'vhs kaset video bant nostalji eski film' },
      { char: '💿', keywords: 'cd dvd disk müzik film veri saklama' },
      { char: '💡', keywords: 'ampul fikir ışık parlak mucit elektrik' },
      { char: '💵', keywords: 'dolar banknot yeşil para nakit finans' },
      { char: '💳', keywords: 'kredi kartı banka kartı ödeme para' },
      { char: '✉️', keywords: 'mektup zarf e-posta posta mesaj' },
      { char: '📝', keywords: 'not defteri kalem yazı not alma ders' },
      { char: '✏️', keywords: 'kurşun kalem yazı çizim eğitim okul' },
      { char: '🔑', keywords: 'anahtar kilit açma güvenli şifre ev' },
      { char: '🔒', keywords: 'kapalı kilit güvenli şifreli kilitli koruma' },
      { char: '🔨', keywords: 'çekiç inşaat alet tamirat metal' },
      { char: '🛡️', keywords: 'kalkan koruma savunma şövalye güvenli' },
      { char: '🎨', keywords: 'ressam paleti sanat boya fırça resim çizim' },
      { char: '🎬', keywords: 'klaket film sinema yönetmen çekim vizyon' },
      { char: '🎤', keywords: 'mikrofon şarkı ses müzik konser' },
      { char: '🎧', keywords: 'kulaklık müzik ses dinleme dj kablosuz' },
      { char: '⚽', keywords: 'futbol topu spor kale maç' },
      { char: '🏀', keywords: 'basketbol topu pota spor maç' },
      { char: '🎯', keywords: 'hedef dart tam onikiden ok spor' },
      { char: '🎲', keywords: 'zar masa oyunu kumar şans tavla' },
      { char: '🎮', keywords: 'oyun konsolu konsol kumanda gamepad video' },
      { char: '✅', keywords: 'onay yeşil tik tamam doğru evet başarılı işaret' },
      { char: '❌', keywords: 'çarpı kırmızı iptal yanlış başarısız hayır yasak' },
      { char: '👁️', keywords: 'göz görme bakış izleme bakmak' },
      { char: '❤️', keywords: 'kırmızı kalp aşk sevgi kalp dostluk' },
      { char: '⭐', keywords: 'yıldız altın puan şans favori popüler' },
      { char: '🌟', keywords: 'parıldayan yıldız parlak yeni puan' },
      { char: '⏳', keywords: 'kum saati süre zaman bekliyor yükleniyor' },
      { char: '❓', keywords: 'soru işareti kırmızı soru merak' },
      { char: '📢', keywords: 'hoparlör megafon duyuru ilan haber ses' },
      { char: '🔔', keywords: 'zil bildirim uyarı ses alarm sarı' },
      { char: '🎈', keywords: 'balon kırmızı parti kutlama doğum günü' },
      { char: '🎉', keywords: 'konfeti parti patlaması kutlama tebrik' },
      { char: '🎁', keywords: 'hediye kutusu sürpriz doğum günü' }
    ]
  }
};

let lastFocusedInput = null;
let currentActiveTab = 'recent';
let isEmojiDeleteMode = false;

// Input Focus Takibi
const addModalBody = document.querySelector('#addModal .modal-body');
if(addModalBody) {
    addModalBody.addEventListener('focusin', (e) => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
            lastFocusedInput = e.target;
        }
    });
}

// Emoji Ekleme Fonksiyonu
function insertEmojiToFocused(emoji) {
    if (lastFocusedInput) {
        const start = lastFocusedInput.selectionStart || 0;
        const end = lastFocusedInput.selectionEnd || 0;
        const text = lastFocusedInput.value;
        lastFocusedInput.value = text.slice(0, start) + emoji + text.slice(end);
        lastFocusedInput.selectionStart = lastFocusedInput.selectionEnd = start + emoji.length;
        lastFocusedInput.focus();
        lastFocusedInput.dispatchEvent(new Event('input', { bubbles: true }));

        // Son kullanılanlara ekle
        addToRecentEmojis(emoji);
    }
}

// Son Kullanılan Emojileri Kaydetme
const getRecentEmojis = () => JSON.parse(localStorage.getItem('recentEmojis') || '[]');
const addToRecentEmojis = (emoji) => {
    let recents = getRecentEmojis();
    recents = recents.filter(x => x !== emoji); // Aynısı varsa çıkar
    recents.unshift(emoji); // Başa ekle
    if (recents.length > 21) recents = recents.slice(0, 21); // 3 satır sınırı
    localStorage.setItem('recentEmojis', JSON.stringify(recents));
    if (currentActiveTab === 'recent') renderEmojisGrid();
};

// Favori Emojileri Kaydetme
const getFavoriteEmojis = () => JSON.parse(localStorage.getItem('customEmojis') || '["✅","❌","👁️","🕶️","⭐","🍿"]');

// Emoji Grid'i Render Etme
const renderEmojisGrid = (searchQuery = '') => {
    const grid = document.getElementById('customEmojiGrid');
    if (!grid) return;
    grid.innerHTML = '';

    let listToRender = [];

    if (searchQuery.trim() !== '') {
        // Arama Aktif: Tüm kategorilerde, favorilerde ve son kullanılanlarda ara
        const query = searchQuery.toLowerCase().trim();
        const addedChars = new Set();

        const allAvailable = [
            ...getFavoriteEmojis().map(char => ({ char, keywords: 'favori özel' })),
            ...getRecentEmojis().map(char => ({ char, keywords: 'son son kullanılan' })),
            ...Object.values(emojiCategories).flatMap(cat => cat.emojis)
        ];

        allAvailable.forEach(item => {
            if ((item.char.includes(query) || (item.keywords && item.keywords.includes(query))) && !addedChars.has(item.char)) {
                listToRender.push(item);
                addedChars.add(item.char);
            }
        });
    } else {
        // Tab Seçimi Aktif
        if (currentActiveTab === 'recent') {
            const recents = getRecentEmojis();
            if (recents.length === 0) {
                grid.innerHTML = `<div style="grid-column: span 7; color: var(--text-muted); font-size:12px; text-align:center; padding: 20px 0;">Son kullanılan emoji yok.</div>`;
                return;
            }
            listToRender = recents.map(char => ({ char }));
        } else if (currentActiveTab === 'custom') {
            listToRender = getFavoriteEmojis().map(char => ({ char }));
        } else if (emojiCategories[currentActiveTab]) {
            listToRender = emojiCategories[currentActiveTab].emojis;
        }
    }

    // Grid Elemanlarını Ekleme
    listToRender.forEach(item => {
        const span = document.createElement('span');
        span.className = 'custom-emoji-item';
        span.innerText = item.char;

        if (currentActiveTab === 'custom' && isEmojiDeleteMode && searchQuery.trim() === '') {
            span.classList.add('delete-mode');
            span.onclick = () => {
                const favorites = getFavoriteEmojis().filter(x => x !== item.char);
                localStorage.setItem('customEmojis', JSON.stringify(favorites));
                renderEmojisGrid();
            };
        } else {
            span.onclick = () => insertEmojiToFocused(item.char);
        }

        grid.appendChild(span);
    });
};

// Sekme Butonlarına Olay Dinleyicisi
document.querySelectorAll('.emoji-tab-btn').forEach(btn => {
    btn.onclick = (e) => {
        e.preventDefault();
        document.querySelectorAll('.emoji-tab-btn').forEach(x => x.classList.remove('active'));
        btn.classList.add('active');

        // Arama kutusunu sıfırla
        const searchInput = document.getElementById('customEmojiSearch');
        if(searchInput) searchInput.value = '';

        currentActiveTab = btn.getAttribute('data-tab');

        // Favoriler sekmesiyse işlemleri göster
        const actions = document.getElementById('customEmojiActions');
        if (actions) {
            actions.style.display = currentActiveTab === 'custom' ? 'flex' : 'none';
        }

        // Düzenleme modunu kapat
        isEmojiDeleteMode = false;
        const toggleBtn = document.getElementById('toggleEmojiDeleteModeBtn');
        if(toggleBtn) {
            toggleBtn.innerHTML = '<i class="fa-solid fa-trash-can" style="font-size:14px;"></i>';
            toggleBtn.title = 'Düzenle';
            toggleBtn.style.background = '#2d201c';
            toggleBtn.style.color = 'var(--danger-color)';
            toggleBtn.style.borderColor = '#4a2824';
        }

        renderEmojisGrid();
    };
});

// Arama Girişi Dinleyicisi
const searchInput = document.getElementById('customEmojiSearch');
if (searchInput) {
    searchInput.addEventListener('input', (e) => {
        const query = e.target.value;
        // Arama yapılıyorsa sekmeleri pasif göster
        if(query.trim() !== '') {
            document.querySelectorAll('.emoji-tab-btn').forEach(x => x.classList.remove('active'));
            const actions = document.getElementById('customEmojiActions');
            if(actions) actions.style.display = 'none';
        } else {
            // Arama silindiyse aktif sekmeyi geri yükle
            const activeBtn = document.querySelector(`.emoji-tab-btn[data-tab="${currentActiveTab}"]`);
            if(activeBtn) activeBtn.classList.add('active');
            const actions = document.getElementById('customEmojiActions');
            if(actions) actions.style.display = currentActiveTab === 'custom' ? 'flex' : 'none';
        }
        renderEmojisGrid(query);
    });
}

// Favori Emojilere Yeni Ekleme
window.addEmojiToFavorites = () => {
    const input = document.getElementById('addCustomEmojiText');
    if (!input) return;
    const char = input.value.trim();
    if (char) {
        let favorites = getFavoriteEmojis();
        if (!favorites.includes(char)) {
            favorites.push(char);
            localStorage.setItem('customEmojis', JSON.stringify(favorites));
            renderEmojisGrid();
        }
        input.value = '';
    }
};

// Favori Emojiler Düzenleme Modu
window.toggleEmojiDeleteMode = () => {
    isEmojiDeleteMode = !isEmojiDeleteMode;
    const toggleBtn = document.getElementById('toggleEmojiDeleteModeBtn');
    if (toggleBtn) {
        if(isEmojiDeleteMode) {
            toggleBtn.innerHTML = '<i class="fa-solid fa-check" style="font-size:14px;"></i>';
            toggleBtn.title = 'Bitti';
            toggleBtn.style.background = 'var(--accent-color)';
            toggleBtn.style.color = '#fff';
            toggleBtn.style.borderColor = 'transparent';
        } else {
            toggleBtn.innerHTML = '<i class="fa-solid fa-trash-can" style="font-size:14px;"></i>';
            toggleBtn.title = 'Düzenle';
            toggleBtn.style.background = '#2d201c';
            toggleBtn.style.color = 'var(--danger-color)';
            toggleBtn.style.borderColor = '#4a2824';
        }
    }
    renderEmojisGrid();
};

// Panel Aç / Kapat
window.toggleEmojiPicker = (e) => {
    e.preventDefault();
    const container = document.getElementById('emojiPickerContainer');
    if(container) {
        const isHidden = container.style.display === 'none' || container.style.display === '';
        container.style.display = isHidden ? 'flex' : 'none';
        if (isHidden) {
            renderEmojisGrid();
        }
    }
};

// Dışarı Tıklayınca Kapatma
document.addEventListener('click', (e) => {
    const container = document.getElementById('emojiPickerContainer');
    const btn = document.getElementById('emojiToggleBtn');
    if (container && btn && container.style.display === 'flex' && !container.contains(e.target) && !btn.contains(e.target)) {
        container.style.display = 'none';
    }
});
