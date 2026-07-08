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
    renderSidebar();
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

window.selectMain = (name, id) => { currentMain = name; currentSub = null; currentSubSub = null; document.getElementById('viewTitle').innerText = name; clearSidebarActive(); document.getElementById(`cbtn-${id}`).classList.add('active'); const slist = document.getElementById(`slist-${id}`); if(slist && !slist.classList.contains('open')) { slist.classList.add('open'); document.getElementById(`toggle-${id}`)?.classList.add('rotated'); } window.renderGallery(); };
window.selectSub = (mName, sName, mId, sId) => { currentMain = mName; currentSub = sName; currentSubSub = null; document.getElementById('viewTitle').innerText = `${mName} / ${sName}`; clearSidebarActive(); document.getElementById(`cbtn-${mId}`).classList.add('active'); document.getElementById(`sbtn-${sId}`).classList.add('active'); const sslist = document.getElementById(`sslist-${sId}`); if(sslist && !sslist.classList.contains('open')) { sslist.classList.add('open'); document.getElementById(`toggle-${sId}`)?.classList.add('rotated'); } window.renderGallery(); };
window.selectSubSub = (mName, sName, ssName, mId, sId, ssId) => { currentMain = mName; currentSub = sName; currentSubSub = ssName; document.getElementById('viewTitle').innerText = `${mName} / ${sName} / ${ssName}`; clearSidebarActive(); document.getElementById(`cbtn-${mId}`).classList.add('active'); document.getElementById(`sbtn-${sId}`).classList.add('active'); document.getElementById(`ssbtn-${ssId}`).classList.add('active'); window.renderGallery(); };
window.selectAll = () => { currentMain = 'Tümü'; currentSub = null; currentSubSub = null; document.getElementById('viewTitle').innerText = 'Tüm Arşiv'; clearSidebarActive(); document.getElementById('btn-all').classList.add('active'); window.renderGallery(); };
const clearSidebarActive = () => { document.querySelectorAll('.category-btn, .sub-btn, .sub-sub-btn').forEach(b => b.classList.remove('active')); };
window.toggleSubMenu = (listId, iconId, e) => { 
    e.stopPropagation(); 
    // Eğer tıklanan yer kategori adı değilse (yani sadece ok ise) menüyü aç/kapa
    if (e.target.classList.contains('fa-chevron-down') || e.target.classList.contains('toggle-sub')) {
        document.getElementById(listId)?.classList.toggle('open'); document.getElementById(iconId)?.classList.toggle('rotated'); 
    }
};
window.changeView = (mode) => { viewMode = mode; document.querySelectorAll('.view-btn').forEach(b => b.classList.remove('active')); document.getElementById(`v-${mode}`)?.classList.add('active'); window.renderGallery(); };

window.toggleViewMode = () => {
    const modes = ['grid', 'list', 'masonry'];
    let idx = modes.indexOf(viewMode);
    viewMode = modes[(idx + 1) % modes.length];
    
    const iconMap = {
        'grid': 'fa-table-cells-large',
        'list': 'fa-list',
        'masonry': 'fa-cubes-stacked'
    };
    
    document.getElementById('viewToggleBtn').innerHTML = `<i class="fa-solid ${iconMap[viewMode]}"></i>`;
    window.renderGallery();
};

let galleryDOMNodes = {};

window.initGalleryNodes = () => {
    const grid = document.getElementById('galleryGrid');
    grid.innerHTML = '';
    galleryDOMNodes = {};
    allItems.forEach(item => {
        const card = document.createElement('div'); 
        card.className = 'card'; 
        card.onclick = () => window.openDetail(item.id);
        const coverUrl = (item.images && item.images.length > 0) ? item.images[0] : item.imageUrl;
        let visual = coverUrl ? `<div class="img-container"><div class="img-blur" style="background-image:url('${cldBlur(coverUrl)}')"></div><img src="${cldThumb(coverUrl)}" class="img-front" loading="lazy" decoding="async"></div>` : `<div class="text-cover">${item.title.substring(0,2).toUpperCase()}</div>`;
        card.innerHTML = `${visual}<div class="card-info"><div class="card-title">${item.title}</div><div class="card-meta"><span>${item.category} ${item.subCategory ? '> '+item.subCategory : ''}</span></div></div>`;
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
        if (isVisible) visibleCount++;
    });

    let emptyMsg = document.getElementById('emptyMsg');
    if(visibleCount === 0) { 
        if (!emptyMsg) {
            emptyMsg = document.createElement('div');
            emptyMsg.id = 'emptyMsg';
            emptyMsg.style = 'grid-column:1/-1; padding:50px; text-align:center; color:#888;';
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
