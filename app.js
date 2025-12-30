
function ensureAppt(appt){
  if(!appt) return {
    patientName: "",
    status: "Planejado",
    procedures: [],
    notes: "",
    docs: []
  };
  return appt;
}

/* =========================
   Agenda Clínica • Dr. Orlando Abreu
   Offline-first PWA + IndexedDB + PDFs via jsPDF
   Regras:
   - Documentos só entram na memória OFICIAL após CONFIRMAÇÃO.
   - Horário é opcional.
   - Ficha clínica visível no atendimento do dia.
   - PDFs sem informações sobre software.
   - Botão exclusivo para PDF.
   ========================= */

(() => {
  "use strict";

  // -----------------------
  // Utilities
  // -----------------------
  const $ = (sel, root=document) => root.querySelector(sel);
  const $$ = (sel, root=document) => Array.from(root.querySelectorAll(sel));
  const pad2 = (n) => String(n).padStart(2, "0");
  const isoDate = (d) => `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
  const prettyDate = (d) => `${pad2(d.getDate())}/${pad2(d.getMonth()+1)}/${d.getFullYear()}`;
  const nowISO = () => new Date().toISOString();

  function toast(msg){
    const el = $("#toast");
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.hidden = true, 2400);
  }

  // -----------------------
  // IndexedDB
  // -----------------------
  const DB_NAME = "oa_agenda_db";
  const DB_VER = 1;
  let db;

  function idbOpen(){
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = () => {
        const d = req.result;

        // settings: key -> value
        if (!d.objectStoreNames.contains("settings")){
          d.createObjectStore("settings", { keyPath: "key" });
        }
        // patients: id auto
        if (!d.objectStoreNames.contains("patients")){
          const s = d.createObjectStore("patients", { keyPath: "id", autoIncrement: true });
          s.createIndex("by_name", "name", { unique:false });
        }
        // appointments: id auto
        if (!d.objectStoreNames.contains("appointments")){
          const s = d.createObjectStore("appointments", { keyPath: "id", autoIncrement: true });
          s.createIndex("by_date", "date", { unique:false });
          s.createIndex("by_patient", "patientName", { unique:false });
        }
        // documents: id auto
        if (!d.objectStoreNames.contains("documents")){
          const s = d.createObjectStore("documents", { keyPath: "id", autoIncrement: true });
          s.createIndex("by_date", "date", { unique:false });
          s.createIndex("by_patient", "patientName", { unique:false });
          s.createIndex("by_type", "type", { unique:false });
          s.createIndex("by_status", "status", { unique:false }); // confirmed|draft|trashed
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function tx(store, mode="readonly"){
    return db.transaction(store, mode).objectStore(store);
  }

  function idbPut(store, obj){
    return new Promise((resolve, reject) => {
      const r = tx(store, "readwrite").put(obj);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  function idbAdd(store, obj){
    return new Promise((resolve, reject) => {
      const r = tx(store, "readwrite").add(obj);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  function idbGet(store, key){
    return new Promise((resolve, reject) => {
      const r = tx(store).get(key);
      r.onsuccess = () => resolve(r.result || null);
      r.onerror = () => reject(r.error);
    });
  }
  function idbDel(store, key){
    return new Promise((resolve, reject) => {
      const r = tx(store, "readwrite").delete(key);
      r.onsuccess = () => resolve(true);
      r.onerror = () => reject(r.error);
    });
  }
  function idbAll(store){
    return new Promise((resolve, reject) => {
      const r = tx(store).getAll();
      r.onsuccess = () => resolve(r.result || []);
      r.onerror = () => reject(r.error);
    });
  }
  function idbIndexRange(store, indexName, range){
    return new Promise((resolve, reject) => {
      const s = tx(store);
      const idx = s.index(indexName);
      const r = idx.getAll(range);
      r.onsuccess = () => resolve(r.result || []);
      r.onerror = () => reject(r.error);
    });
  }

  // -----------------------
  // Default profile/settings
  // -----------------------
  const DEFAULT_PROFILE = {
    name: "Orlando Abreu Gomes da Silva",
    cro: "CRO-PA 5165",
    title: "Cirurgião-Dentista",
    spec: "Especialista em Cirurgia Buco-Maxilo-Facial",
    address: "",
    phone: "(91) 99987-3835",
    whatsapp: "5591999873835",
    whatsappMsg: "Olá, Dr. Orlando Abreu. Gostaria de mais informações.",
    showPhoneInPdf: true,
    enableTrash: true,
  };

  async function getSetting(key, fallback=null){
    const rec = await idbGet("settings", key);
    return rec ? rec.value : fallback;
  }
  async function setSetting(key, value){
    await idbPut("settings", { key, value });
  }

  // -----------------------
  // App state
  // -----------------------
  const state = {
    route: "agenda",
    selectedDate: isoDate(new Date()),
    calCursor: new Date(),
    apptEditing: null,    // appointment object
    docDraft: null,       // current draft (documents store) linked to appt
    showTrash: false,
    profile: {...DEFAULT_PROFILE},
  };

  // -----------------------
  // Init
  // -----------------------
  async function init(){
    db = await idbOpen();

    // Load profile
    const prof = await getSetting("profile", null);
    state.profile = prof ? { ...DEFAULT_PROFILE, ...prof } : {...DEFAULT_PROFILE};
    await setSetting("profile", state.profile); // ensure exists

    // First run: register SW
    if ("serviceWorker" in navigator){
      try{
        await navigator.serviceWorker.register("./sw.js");
      }catch(e){
        console.warn("SW register failed", e);
      }
    }

    bindUI();
    hydrateProfileUI();
    updateWelcomeAndWhats();
    await renderAll();
  }

  // -----------------------
  // UI binding
  // -----------------------
  function bindUI(){
    // sidebar nav
    $$(".nav__item").forEach(btn => {
      btn.addEventListener("click", async (e) => {\n        e.preventDefault();
        const route = btn.dataset.route;
        setRoute(route);
        await renderAll();
      });
    });

    // hamburger
    $("#hamburger").addEventListener("click", () => {
      $(".sidebar").classList.toggle("is-open");
    });

    // calendar controls
    $("#calPrev").addEventListener("click", async () => {
      state.calCursor = new Date(state.calCursor.getFullYear(), state.calCursor.getMonth()-1, 1);
      await renderCalendar();
    });
    $("#calNext").addEventListener("click", async () => {
      state.calCursor = new Date(state.calCursor.getFullYear(), state.calCursor.getMonth()+1, 1);
      await renderCalendar();
    });
    $("#calToday").addEventListener("click", async () => {
      const d = new Date();
      state.calCursor = new Date(d.getFullYear(), d.getMonth(), 1);
      state.selectedDate = isoDate(d);
      await renderAll();
    });

    // add patient
    $("#btnAddPatient").addEventListener("click", () => openPatientEditor());
    // add appointment
    $("#btnAddAppt").addEventListener("click", () => openApptModalForDate(state.selectedDate));

    // config save
    $("#btnSaveProfile").addEventListener("click", async (e) => {
      e.preventDefault();
      await saveProfileFromUI();
      toast("Perfil salvo.");
    });

    // backup export/import
    $("#btnBackupExport").addEventListener("click", exportBackup);
    $("#btnBackupImport").addEventListener("click", () => $("#backupFile").click());
    $("#backupFile").addEventListener("change", async (e) => {
      if (!e.target.files?.[0]) return;
      await importBackup(e.target.files[0]);
      e.target.value = "";
    });

    // safety buttons
    $("#btnNuke").addEventListener("click", async () => {
      if (!confirm("Apagar TUDO? Isso não pode ser desfeito.")) return;
      await nukeAll();
      toast("Tudo apagado.");
      await renderAll();
    });
    $("#btnReindex").addEventListener("click", async () => {
      // In this version, indices are part of schema; reindex is a no-op but kept for UX.
      toast("OK. Estrutura verificada.");
    });

    // docs filters
    $("#btnDocFilter").addEventListener("click", renderDocuments);
    $("#btnDocClear").addEventListener("click", async () => {
      $("#docTypeFilter").value = "";
      $("#docPatientFilter").value = "";
      $("#docDateFrom").value = "";
      $("#docDateTo").value = "";
      await renderDocuments();
    });
    $("#btnTrashToggle").addEventListener("click", async () => {
      state.showTrash = !state.showTrash;
      $("#btnTrashToggle").textContent = state.showTrash ? "Ver Ativos" : "Ver Lixeira";
      await renderDocuments();
    });
    $("#btnPurgeTrash").addEventListener("click", async () => {
      if (!confirm("Esvaziar lixeira?")) return;
      const docs = await idbAll("documents");
      const enableTrash = state.profile.enableTrash;
      const toDelete = docs.filter(d => d.status === "trashed");
      for (const d of toDelete) await idbDel("documents", d.id);
      toast(enableTrash ? "Lixeira esvaziada." : "Nada para esvaziar.");
      await renderDocuments();
    });

    // global search
    $("#globalSearch").addEventListener("input", debounce(async (e) => {
      const q = e.target.value.trim();
      await renderSearchHint(q);
    }, 180));

    document.addEventListener("click", (e) => {
      // close sidebar on mobile click outside
      if (window.innerWidth <= 860){
        const sb = $(".sidebar");
        if (sb.classList.contains("is-open")){
          const inside = e.target.closest(".sidebar") || e.target.closest("#hamburger");
          if (!inside) sb.classList.remove("is-open");
        }
      }
    });

    // modal events
    $("#apptClose").addEventListener("click", closeApptModal);
    // close modal on backdrop click
    $("#modalAppt").addEventListener("click", (e) => {
      if (e.target && e.target.id === "modalAppt") closeApptModal();
    });
    // close modal on ESC
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !$("#modalAppt").hidden) closeApptModal();
    });

    $("#btnSaveAppt").addEventListener("click", saveApptFromUI);
    $("#btnDeleteAppt").addEventListener("click", deleteCurrentAppt);
    $("#btnAddProc").addEventListener("click", addProcFromUI);

    $$(".docbtn").forEach(b => b.addEventListener("click", (e) => { e.preventDefault(); selectDocType(b.dataset.doc); }));

    $("#btnSaveDraft").addEventListener("click", saveDraft);
    $("#btnConfirmDoc").addEventListener("click", confirmDoc);
    $("#btnPdfOnly").addEventListener("click", generatePdfOnly);
  }

  function debounce(fn, ms){
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  function setRoute(route){
    state.route = route;
    $$(".nav__item").forEach(b => b.classList.toggle("is-active", b.dataset.route === route));
    $("#viewAgenda").hidden = route !== "agenda";
    $("#viewPacientes").hidden = route !== "pacientes";
    $("#viewDocumentos").hidden = route !== "documentos";
    $("#viewConfig").hidden = route !== "config";

    const titles = {
      agenda: ["Agenda", "Mini-calendário com memória clínica."],
      pacientes: ["Pacientes", "Cadastro simples + busca rápida."],
      documentos: ["Documentos", "Memória oficial (confirmados) + lixeira opcional."],
      config: ["Configurações", "Perfil profissional e segurança."],
    };
    $("#viewTitle").textContent = titles[route][0];
    $("#viewSubtitle").textContent = titles[route][1];
  }

  // -----------------------
  // Profile
  // -----------------------
  function hydrateProfileUI(){
    $("#proName").value = state.profile.name || "";
    $("#proCRO").value = state.profile.cro || "";
    $("#proTitle").value = state.profile.title || "";
    $("#proSpec").value = state.profile.spec || "";
    $("#proAddress").value = state.profile.address || "";
    $("#proPhone").value = state.profile.phone || "";
    $("#proWhats").value = state.profile.whatsapp || "";
    $("#proWhatsMsg").value = state.profile.whatsappMsg || "";
    $("#showPhoneInPdf").checked = !!state.profile.showPhoneInPdf;
    $("#enableTrash").checked = !!state.profile.enableTrash;
  }

  async function saveProfileFromUI(){
    state.profile = {
      ...state.profile,
      name: $("#proName").value.trim(),
      cro: $("#proCRO").value.trim(),
      title: $("#proTitle").value.trim(),
      spec: $("#proSpec").value.trim(),
      address: $("#proAddress").value.trim(),
      phone: $("#proPhone").value.trim(),
      whatsapp: $("#proWhats").value.trim(),
      whatsappMsg: $("#proWhatsMsg").value.trim(),
      showPhoneInPdf: $("#showPhoneInPdf").checked,
      enableTrash: $("#enableTrash").checked,
    };
    await setSetting("profile", state.profile);
    updateWelcomeAndWhats();
  }

  function updateWelcomeAndWhats(){
    const first = (state.profile.name || "Orlando Abreu").split(" ")[0] || "Orlando";
    $("#welcomeText").textContent = `Bem-vindo, Dr. ${first} Abreu`;
    const wa = $("#waLink");
    const num = (state.profile.whatsapp || "").replace(/\D/g,"");
    if (num){
      const msg = encodeURIComponent(state.profile.whatsappMsg || "");
      wa.href = `https://wa.me/${num}${msg ? `?text=${msg}` : ""}`;
      wa.style.opacity = "1";
      wa.style.pointerEvents = "auto";
    }else{
      wa.href = "#";
      wa.style.opacity = ".5";
      wa.style.pointerEvents = "none";
    }
  }

  // -----------------------
  // Render
  // -----------------------
  async function renderAll(){
    await renderCalendar();
    await renderDay();
    await renderPatients();
    await renderDocuments();
    await refreshPatientDatalist();
  }

  async function renderCalendar(){
    const host = $("#miniCalendar");
    host.innerHTML = "";

    const cursor = new Date(state.calCursor.getFullYear(), state.calCursor.getMonth(), 1);
    const monthName = cursor.toLocaleDateString("pt-BR", { month:"long", year:"numeric" });
    const head = document.createElement("div");
    head.className = "cal__head";
    head.innerHTML = `<div class="cal__month">${monthName.charAt(0).toUpperCase()+monthName.slice(1)}</div>`;
    host.appendChild(head);

    const dow = ["D","S","T","Q","Q","S","S"];
    const grid = document.createElement("div");
    grid.className = "cal__grid";
    dow.forEach(x => {
      const el = document.createElement("div");
      el.className = "cal__dow";
      el.textContent = x;
      grid.appendChild(el);
    });

    const firstDow = new Date(cursor.getFullYear(), cursor.getMonth(), 1).getDay();
    const daysInMonth = new Date(cursor.getFullYear(), cursor.getMonth()+1, 0).getDate();

    // Preload: which days have appointments
    const monthStart = isoDate(new Date(cursor.getFullYear(), cursor.getMonth(), 1));
    const monthEnd = isoDate(new Date(cursor.getFullYear(), cursor.getMonth(), daysInMonth));
    const appts = await idbAll("appointments");
    const daysWith = new Set(appts.filter(a => a.date >= monthStart && a.date <= monthEnd).map(a => a.date));

    // leading blanks from prev month
    const prevMonthDays = new Date(cursor.getFullYear(), cursor.getMonth(), 0).getDate();
    for (let i=0;i<firstDow;i++){
      const dayNum = prevMonthDays - (firstDow-1-i);
      const d = new Date(cursor.getFullYear(), cursor.getMonth()-1, dayNum);
      grid.appendChild(dayCell(d, true, daysWith));
    }

    for (let day=1; day<=daysInMonth; day++){
      const d = new Date(cursor.getFullYear(), cursor.getMonth(), day);
      grid.appendChild(dayCell(d, false, daysWith));
    }

    // trailing blanks
    const totalCells = firstDow + daysInMonth;
    const trailing = (7 - (totalCells % 7)) % 7;
    for (let i=1;i<=trailing;i++){
      const d = new Date(cursor.getFullYear(), cursor.getMonth()+1, i);
      grid.appendChild(dayCell(d, true, daysWith));
    }

    host.appendChild(grid);
  }

  function dayCell(dateObj, muted, daysWith){
    const el = document.createElement("div");
    el.className = "cal__day" + (muted ? " is-muted" : "");
    el.textContent = dateObj.getDate();

    const dIso = isoDate(dateObj);
    if (daysWith.has(dIso)) el.classList.add("has-dot");
    if (dIso === state.selectedDate) el.classList.add("is-selected");

    el.addEventListener("click", async () => {
      state.selectedDate = dIso;
      // if clicked day outside month, move cursor
      state.calCursor = new Date(dateObj.getFullYear(), dateObj.getMonth(), 1);
      await renderAll();
    });

    return el;
  }

  async function renderDay(){
    const d = new Date(state.selectedDate + "T12:00:00");
    $("#dayTitle").textContent = prettyDate(d);
    $("#daySubtitle").textContent = "Atendimentos e procedimentos";

    const list = $("#dayList");
    list.innerHTML = "";

    let appts = await idbIndexRange("appointments", "by_date", IDBKeyRange.only(state.selectedDate));
    appts.sort((a,b) => (a.time || "").localeCompare(b.time || "") || (a.patientName || "").localeCompare(b.patientName || ""));

    if (!appts.length){
      const empty = document.createElement("div");
      empty.className = "hint";
      empty.style.padding = "10px 6px";
      empty.textContent = "Nenhum atendimento neste dia. Clique em “+ Atendimento”.";
      list.appendChild(empty);
      return;
    }

    for (const a of appts){
      const el = document.createElement("div");
      el.className = "appt";
      const statusPill = statusToPill(a.status);
      const procCount = (a.procedures || []).length;
      el.innerHTML = `
        <div class="appt__left">
          <div class="appt__name">${escapeHtml(a.patientName || "Sem nome")}</div>
          <div class="appt__meta">
            ${a.time ? `<span class="pill">${escapeHtml(a.time)}</span>` : `<span class="pill">Sem horário</span>`}
            <span class="pill ${statusPill.cls}">${statusPill.label}</span>
            <span class="pill">${procCount} procedimento(s)</span>
          </div>
        </div>
        <div class="appt__right">
          <span class="chev">›</span>
        </div>
      `;
      el.addEventListener("click", () => openApptModal(a.id));
      list.appendChild(el);
    }
  }

  function statusToPill(status){
    const map = {
      planejado: {label:"Planejado", cls:"warn"},
      realizado: {label:"Realizado", cls:"ok"},
      faltou: {label:"Faltou", cls:"bad"},
      remarcado:{label:"Remarcado", cls:"warn"},
    };
    return map[status] || {label:"—", cls:""};
  }

  async function renderPatients(){
    const tbody = $("#patientTable");
    tbody.innerHTML = "";
    const patients = await idbAll("patients");
    patients.sort((a,b) => (a.name||"").localeCompare(b.name||""));

    if (!patients.length){
      const tr = document.createElement("tr");
      tr.innerHTML = `<td colspan="4" style="color:var(--muted)">Nenhum paciente cadastrado.</td>`;
      tbody.appendChild(tr);
      return;
    }

    for (const p of patients){
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><b>${escapeHtml(p.name||"")}</b></td>
        <td>${escapeHtml(p.contact||"")}</td>
        <td>${escapeHtml(p.notes||"")}</td>
        <td class="right">
          <button class="ghost" data-act="edit">Editar</button>
          <button class="danger" data-act="del">Excluir</button>
        </td>
      `;
      tr.querySelector('[data-act="edit"]').addEventListener("click", () => openPatientEditor(p));
      tr.querySelector('[data-act="del"]').addEventListener("click", async () => {
        if (!confirm("Excluir paciente?")) return;
        await idbDel("patients", p.id);
        toast("Paciente excluído.");
        await renderPatients();
        await refreshPatientDatalist();
      });
      tbody.appendChild(tr);
    }
  }

  async function renderDocuments(){
    const host = $("#docList");
    host.innerHTML = "";

    const type = $("#docTypeFilter").value;
    const patient = $("#docPatientFilter").value.trim().toLowerCase();
    const from = $("#docDateFrom").value;
    const to = $("#docDateTo").value;

    const docs = await idbAll("documents");
    const enableTrash = !!state.profile.enableTrash;

    let filtered = docs.filter(d => {
      const isTrash = d.status === "trashed";
      if (state.showTrash){
        if (!enableTrash) return false;
        if (!isTrash) return false;
      }else{
        // show only confirmed by default
        if (isTrash) return false;
        if (d.status !== "confirmed") return false;
      }
      if (type && d.type !== type) return false;
      if (patient && !(String(d.patientName||"").toLowerCase().includes(patient))) return false;
      if (from && d.date < from) return false;
      if (to && d.date > to) return false;
      return true;
    });

    filtered.sort((a,b) => (b.date||"").localeCompare(a.date||"") || (b.createdAt||"").localeCompare(a.createdAt||""));

    if (!filtered.length){
      const empty = document.createElement("div");
      empty.className = "hint";
      empty.style.padding = "10px 6px";
      empty.textContent = state.showTrash ? "Lixeira vazia." : "Nenhum documento confirmado ainda.";
      host.appendChild(empty);
      return;
    }

    for (const d of filtered){
      const row = document.createElement("div");
      row.className = "docrow";
      const label = docLabel(d.type);
      const dPretty = d.date ? prettyDate(new Date(d.date+"T12:00:00")) : "—";
      row.innerHTML = `
        <div>
          <div class="docrow__title">${label} • ${escapeHtml(d.patientName||"")}</div>
          <div class="docrow__meta">
            <span>${dPretty}</span>
            <span>${escapeHtml(d.snapshot?.cro || state.profile.cro || "")}</span>
          </div>
        </div>
        <div class="docrow__actions">
          <button class="btn btn--pdf" data-act="pdf">PDF</button>
          ${state.showTrash ? `<button class="ghost" data-act="restore">Restaurar</button>` : (enableTrash ? `<button class="ghost" data-act="trash">Excluir</button>` : `<button class="danger" data-act="del">Excluir</button>`)}
        </div>
      `;
      row.querySelector('[data-act="pdf"]').addEventListener("click", () => generatePdfFromDoc(d));
      const actRestore = row.querySelector('[data-act="restore"]');
      if (actRestore){
        actRestore.addEventListener("click", async () => {
          d.status = "confirmed";
          await idbPut("documents", d);
          toast("Restaurado.");
          await renderDocuments();
        });
      }
      const actTrash = row.querySelector('[data-act="trash"]');
      if (actTrash){
        actTrash.addEventListener("click", async () => {
          if (!confirm("Mover para lixeira?")) return;
          d.status = "trashed";
          d.trashedAt = nowISO();
          await idbPut("documents", d);
          toast("Movido para lixeira.");
          await renderDocuments();
        });
      }
      const actDel = row.querySelector('[data-act="del"]');
      if (actDel){
        actDel.addEventListener("click", async () => {
          if (!confirm("Excluir definitivamente?")) return;
          await idbDel("documents", d.id);
          toast("Excluído.");
          await renderDocuments();
        });
      }

      host.appendChild(row);
    }
  }

  async function renderSearchHint(q){
    const hint = $("#searchHint");
    if (!q){
      hint.hidden = true;
      hint.innerHTML = "";
      return;
    }
    const qq = q.toLowerCase();
    const appts = await idbAll("appointments");
    const docs = await idbAll("documents");

    const apptMatches = appts.filter(a => (
      (a.patientName||"").toLowerCase().includes(qq) ||
      (a.notes||"").toLowerCase().includes(qq) ||
      (a.procedures||[]).some(p => (p||"").toLowerCase().includes(qq))
    )).slice(0, 5);

    const docMatches = docs.filter(d => d.status==="confirmed" && (
      (d.patientName||"").toLowerCase().includes(qq) ||
      (d.body||"").toLowerCase().includes(qq) ||
      (d.type||"").toLowerCase().includes(qq)
    )).slice(0, 5);

    let html = "";
    if (apptMatches.length){
      html += `<div style="font-weight:800;margin:6px 4px 8px;">Atendimentos</div>`;
      html += apptMatches.map(a => {
        const pd = a.date ? prettyDate(new Date(a.date+"T12:00:00")) : "—";
        return `<div class="docrow" style="margin:0 0 8px; cursor:pointer" data-kind="appt" data-id="${a.id}">
          <div><div class="docrow__title">${escapeHtml(a.patientName||"")} • ${pd}</div>
          <div class="docrow__meta"><span>${escapeHtml(a.time||"Sem horário")}</span><span>${(a.procedures||[]).length} procedimento(s)</span></div></div>
          <div class="docrow__actions"><span class="pill">Abrir</span></div>
        </div>`;
      }).join("");
    }
    if (docMatches.length){
      html += `<div style="font-weight:800;margin:12px 4px 8px;">Documentos</div>`;
      html += docMatches.map(d => {
        const label = docLabel(d.type);
        const pd = d.date ? prettyDate(new Date(d.date+"T12:00:00")) : "—";
        return `<div class="docrow" style="margin:0 0 8px; cursor:pointer" data-kind="doc" data-id="${d.id}">
          <div><div class="docrow__title">${label} • ${escapeHtml(d.patientName||"")} • ${pd}</div>
          <div class="docrow__meta"><span>Confirmado</span></div></div>
          <div class="docrow__actions"><span class="pill">PDF</span></div>
        </div>`;
      }).join("");
    }

    hint.innerHTML = html || `<div style="padding:8px 6px;color:var(--muted)">Nada encontrado.</div>`;
    hint.hidden = false;

    // attach click handlers
    $$("[data-kind]", hint).forEach(el => {
      el.addEventListener("click", async () => {
        const kind = el.dataset.kind;
        const id = Number(el.dataset.id);
        hint.hidden = true;
        if (kind === "appt"){
          setRoute("agenda");
          await renderAll();
          await openApptModal(id);
        }else{
          const d = await idbGet("documents", id);
          if (d) generatePdfFromDoc(d);
        }
      });
    });
  }

  // -----------------------
  // Patients
  // -----------------------
  async function openPatientEditor(existing=null){
    const name = prompt("Nome do paciente:", existing?.name || "");
    if (name === null) return;
    const contact = prompt("Contato (opcional):", existing?.contact || "");
    if (contact === null) return;
    const notes = prompt("Observações (opcional):", existing?.notes || "");
    if (notes === null) return;

    const p = {
      id: existing?.id,
      name: name.trim(),
      contact: (contact||"").trim(),
      notes: (notes||"").trim(),
      updatedAt: nowISO(),
      createdAt: existing?.createdAt || nowISO(),
    };
    if (!p.name){ toast("Nome obrigatório."); return; }

    if (existing) await idbPut("patients", p);
    else await idbAdd("patients", p);

    toast("Paciente salvo.");
    await renderPatients();
    await refreshPatientDatalist();
  }

  async function refreshPatientDatalist(){
    const dl = $("#patientDatalist");
    dl.innerHTML = "";
    const patients = await idbAll("patients");
    patients.sort((a,b) => (a.name||"").localeCompare(b.name||""));
    patients.forEach(p => {
      const opt = document.createElement("option");
      opt.value = p.name;
      dl.appendChild(opt);
    });
  }

  // -----------------------
  // Appointment modal
  // -----------------------
  async function openApptModalForDate(dateIso){
    // new appt
    const appt = {
      date: dateIso,
      patientName: "",
      time: "",
      status: "planejado",
      ficha: "",
      procedures: [],
      notes: "",
      updatedAt: nowISO(),
      createdAt: nowISO(),
    };
    state.apptEditing = appt;
    state.docDraft = null;
    showApptModal();
  }

  async function openApptModal(apptId){
    const appt = await idbGet("appointments", apptId);
    if (!appt){ toast("Atendimento não encontrado."); return; }
    state.apptEditing = appt;

    // Load latest draft for this appointment (if any)
    const docs = await idbAll("documents");
    const drafts = docs.filter(d => d.appointmentId === appt.id && d.status === "draft");
    drafts.sort((a,b) => (b.updatedAt||"").localeCompare(a.updatedAt||""));
    state.docDraft = drafts[0] || null;

    showApptModal();
  }

  function showApptModal(){
    const m = $("#modalAppt");
    m.hidden = false;

    const a = state.apptEditing;
    $("#apptTitle").textContent = a.id ? "Atendimento" : "Novo atendimento";
    $("#apptSubtitle").textContent = `${prettyDate(new Date(a.date+"T12:00:00"))}`;

    $("#apptPatientName").value = a.patientName || "";
    $("#apptTime").value = a.time || "";
    $("#apptStatus").value = a.status || "planejado";
    $("#apptFicha").value = a.ficha || "";
    $("#apptNotes").value = a.notes || "";

    renderProceduresChips();

    // default doc selection
    const type = state.docDraft?.type || "receita";
    selectDocType(type);

    $("#docBody").value = state.docDraft?.body || defaultDocTemplate(type, a);
    renderDocPreview();
  }

  function closeApptModal(){
    $("#modalAppt").hidden = true;
    state.apptEditing = null;
    state.docDraft = null;
  }

  async function saveApptFromUI(){
  currentAppt = ensureAppt(currentAppt);

    const a = state.apptEditing;
    a.patientName = $("#apptPatientName").value.trim();
    a.time = $("#apptTime").value.trim();
    a.status = $("#apptStatus").value;
    a.ficha = $("#apptFicha").value.trim();
    a.notes = $("#apptNotes").value.trim();
    a.updatedAt = nowISO();

    if (!a.patientName){ toast("Informe o nome do paciente."); return; }

    if (a.id){
      await idbPut("appointments", a);
    }else{
      const id = await idbAdd("appointments", a);
      a.id = id;
      state.apptEditing = a;
    }

    toast("Atendimento salvo.");
    await renderAll();
  }

  async function deleteCurrentAppt(){
    const a = state.apptEditing;
    if (!a?.id){ closeApptModal(); return; }
    if (!confirm("Excluir este atendimento?")) return;

    // delete related drafts (keep confirmed docs as separate memory unless user deletes them)
    const docs = await idbAll("documents");
    const relDrafts = docs.filter(d => d.appointmentId === a.id && d.status === "draft");
    for (const d of relDrafts) await idbDel("documents", d.id);

    await idbDel("appointments", a.id);
    toast("Atendimento excluído.");
    closeApptModal();
    await renderAll();
  }

  function addProcFromUI(){
    const val = $("#procInput").value.trim();
    if (!val) return;
    const a = state.apptEditing;
    a.procedures = a.procedures || [];
    a.procedures.push(val);
    $("#procInput").value = "";
    renderProceduresChips();
  }

  function renderProceduresChips(){
    const host = $("#procChips");
    host.innerHTML = "";
    const a = state.apptEditing;
    (a.procedures||[]).forEach((p, idx) => {
      const chip = document.createElement("div");
      chip.className = "chip";
      chip.innerHTML = `<span>${escapeHtml(p)}</span><button title="Remover">✕</button>`;
      chip.querySelector("button").addEventListener("click", () => {
        a.procedures.splice(idx,1);
        renderProceduresChips();
      });
      host.appendChild(chip);
    });
  }

  // -----------------------
  // Documents (draft/confirm/pdf)
  // -----------------------
  function docLabel(type){
    const map = {
      receita: "Receita",
      atestado: "Atestado",
      recibo: "Recibo",
      orcamento: "Orçamento",
      laudo: "Laudo",
      ficha: "Ficha Clínica",
    };
    return map[type] || "Documento";
  }

  function selectDocType(type){
    $("#docType").value = docLabel(type);
    $$(".docbtn").forEach(b => b.classList.toggle("is-active", b.dataset.doc === type));

    // update draft object type
    if (state.docDraft && state.docDraft.status === "draft"){
      state.docDraft.type = type;
    }

    const a = state.apptEditing;
    // if body empty, apply template
    const body = $("#docBody").value.trim();
    if (!body || body.startsWith("[MODELO]")){
      $("#docBody").value = defaultDocTemplate(type, a);
    }
    renderDocPreview();
  }

  function defaultDocTemplate(type, appt){
    const pname = appt?.patientName ? appt.patientName : "________________________________";
    const procs = (appt?.procedures||[]).length ? appt.procedures.map(x=>`- ${x}`).join("\n") : "- __________________________________";
    if (type === "receita"){
      return `\n\n\n`;
    }
    if (type === "atestado"){
      return `Atesto para os devidos fins que ${pname} esteve sob meus cuidados profissionais nesta data.\n\nRecomenda-se afastamento por ____ dia(s), a contar de ____/____/____.\n`;
    }
    if (type === "recibo"){
      return `Recebi de ${pname} a quantia de R$ ____________, referente a: ________________________________.\n\nForma de pagamento: ___________________.\n`;
    }
    if (type === "orcamento"){
      return `Orçamento para ${pname}:\n\n${procs}\n\nValor total: R$ ____________\nValidade: ____ dias.\n`;
    }
    if (type === "laudo"){
      return `Laudo clínico referente a ${pname}:\n\nDescrever achados, exames, hipótese diagnóstica e conduta.\n`;
    }
    if (type === "ficha"){
      return `Ficha clínica (resumo) de ${pname}:\n\nQueixa principal: _______________________\nHistórico: ______________________________\nObservações: ____________________________\n`;
    }
    return "";
  }

  async function saveDraft(){
    const a = state.apptEditing;
    if (!a?.id){
      await saveApptFromUI(); // ensure appt has id
      if (!state.apptEditing?.id) return;
    }

    const type = currentDocType();
    const body = $("#docBody").value;
    const draft = state.docDraft && state.docDraft.status === "draft"
      ? state.docDraft
      : {
          appointmentId: state.apptEditing.id,
          date: state.apptEditing.date,
          patientName: state.apptEditing.patientName,
          type,
          body,
          status: "draft",
          snapshot: snapshotProfile(), // snapshot at draft time (can change on confirm)
          createdAt: nowISO(),
          updatedAt: nowISO(),
        };

    draft.type = type;
    draft.body = body;
    draft.patientName = state.apptEditing.patientName;
    draft.date = state.apptEditing.date;
    draft.snapshot = snapshotProfile();
    draft.updatedAt = nowISO();

    if (draft.id) await idbPut("documents", draft);
    else draft.id = await idbAdd("documents", draft);

    state.docDraft = draft;
    toast("Rascunho salvo.");
    await renderDocuments(); // doesn't show drafts, but keeps db consistent
  }

  async function confirmDoc(){
    const a = state.apptEditing;
    if (!a?.id){
      await saveApptFromUI();
      if (!state.apptEditing?.id) return;
    }
    const type = currentDocType();
    const body = $("#docBody").value.trim();
    if (!body && type !== "receita"){
      if (!confirm("Conteúdo vazio. Confirmar mesmo assim?")) return;
    }

    // Create confirmed doc (snapshot locked)
    const confirmed = {
      appointmentId: state.apptEditing.id,
      date: state.apptEditing.date,
      patientName: state.apptEditing.patientName,
      type,
      body,
      status: "confirmed",
      snapshot: snapshotProfile(), // lock snapshot here
      createdAt: nowISO(),
      updatedAt: nowISO(),
    };
    const id = await idbAdd("documents", confirmed);
    confirmed.id = id;

    toast("Documento confirmado e salvo na memória.");
    await renderDocuments();
  }

  function currentDocType(){
    const active = $(".docbtn.is-active");
    return active ? active.dataset.doc : "receita";
  }

  function snapshotProfile(){
    // Snapshot to keep old documents consistent (legal + histórico)
    const p = state.profile;
    return {
      name: p.name, cro: p.cro, title: p.title, spec: p.spec,
      address: p.address, phone: p.phone,
      showPhoneInPdf: p.showPhoneInPdf,
      enableTrash: p.enableTrash,
    };
  }

  function renderDocPreview(){
    const type = currentDocType();
    const body = $("#docBody").value || "";
    const a = state.apptEditing;
    const snap = snapshotProfile();
    $("#docPreview").innerHTML = previewHtml(type, body, a, snap);
  }

  $("#docBody")?.addEventListener?.("input", debounce(renderDocPreview, 120));

  function previewHtml(type, body, appt, snap){
    const header = `
      <div class="h">${escapeHtml(snap.name||"")}</div>
      <div class="sub">${escapeHtml(snap.cro||"")}</div>
      <div class="sub">${escapeHtml(snap.title||"")}</div>
      <div class="sub">${escapeHtml(snap.spec||"")}</div>
    `;
    const footerParts = [];
    if (snap.address) footerParts.push(escapeHtml(snap.address).replace(/\n/g,"<br>"));
    // phone inclusion (text only) recommended in Recibo/Orçamento; still controllable
    const showPhone = !!snap.showPhoneInPdf;
    const allowPhoneHere = ["recibo","orcamento","ficha"].includes(type);
    if (showPhone && allowPhoneHere && snap.phone) footerParts.push(`Contato: ${escapeHtml(snap.phone)}`);
    const dateLine = prettyDate(new Date((appt?.date || state.selectedDate)+"T12:00:00"));
    footerParts.push(dateLine);

    const frame = `
      <div class="frame">
        <div style="border:1px solid rgba(0,0,0,.14); border-bottom:none; border-radius:12px 12px 0 0; padding:12px 12px 10px;">
          ${header}
        </div>
        <div style="border:1px solid rgba(0,0,0,.14); border-top:none; border-bottom:none; padding: 10px 12px 0;">
          <div style="font-weight:800; text-align:center; margin-top:2px;">${docLabel(type)}</div>
        </div>
        <div class="box">${escapeHtml(body || "")}</div>
        <div class="foot">${footerParts.join("<br>")}</div>
      </div>
    `;
    return frame;
  }

  // -----------------------
  // PDF generation (exclusive button)
  // -----------------------
  async function generatePdfOnly(){
    try{
      const type = currentDocType();
      const body = $("#docBody").value || "";
      const a = state.apptEditing;
      const snap = snapshotProfile();
      await pdfGenerateAndOpen({ type, body, patientName: a?.patientName || "", date: a?.date || state.selectedDate, snapshot: snap });
    }catch(e){
      console.error(e);
      toast("Falha ao gerar PDF. Verifique internet no primeiro uso (carregar jsPDF).");
    }
  }

  async function generatePdfFromDoc(doc){
    try{
      await pdfGenerateAndOpen(doc);
    }catch(e){
      console.error(e);
      toast("Falha ao gerar PDF.");
    }
  }

  async function pdfGenerateAndOpen(doc){
    // jsPDF is loaded via CDN; cached by SW after first load.
    const { jsPDF } = window.jspdf || {};
    if (!jsPDF) throw new Error("jsPDF not loaded");

    const snap = doc.snapshot || snapshotProfile();
    const type = doc.type || "receita";
    const label = docLabel(type);
    const date = doc.date || state.selectedDate;
    const patient = doc.patientName || "";

    // A4 portrait in mm
    const pdf = new jsPDF({ unit:"mm", format:"a4" });
    const pageW = 210, pageH = 297;
    const margin = 14;
    const innerW = pageW - margin*2;

    // Border: lateral + superior (and subtle bottom to finish)
    pdf.setDrawColor(60, 60, 60);
    pdf.setLineWidth(0.3);
    // top border
    pdf.line(margin, margin, pageW-margin, margin);
    // left/right borders
    pdf.line(margin, margin, margin, pageH-margin);
    pdf.line(pageW-margin, margin, pageW-margin, pageH-margin);
    // bottom (very subtle)
    pdf.setDrawColor(90, 90, 90);
    pdf.line(margin, pageH-margin, pageW-margin, pageH-margin);

    // Header (centralized)
    let y = margin + 10;
    pdf.setTextColor(20,20,20);
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(13);
    pdf.text(snap.name || "", pageW/2, y, { align:"center" });

    y += 6;
    pdf.setFont("helvetica","normal");
    pdf.setFontSize(11);
    pdf.text(snap.cro || "", pageW/2, y, { align:"center" });

    y += 5;
    pdf.setFontSize(10.5);
    pdf.text(snap.title || "", pageW/2, y, { align:"center" });

    y += 5;
    pdf.text(snap.spec || "", pageW/2, y, { align:"center" });

    y += 8;
    pdf.setFont("helvetica","bold");
    pdf.setFontSize(12);
    pdf.text(label, pageW/2, y, { align:"center" });

    // Body box
    y += 6;
    const boxTop = y;
    const boxH = 165;
    pdf.setDrawColor(120,120,120);
    pdf.setLineWidth(0.2);
    pdf.roundedRect(margin+2, boxTop, innerW-4, boxH, 2, 2);

    // Body text
    const bodyText = (type === "receita" && !doc.body) ? "" : (doc.body || "");
    pdf.setFont("helvetica","normal");
    pdf.setFontSize(11);
    pdf.setTextColor(10,10,10);

    const textX = margin+6;
    const textY = boxTop + 8;
    const maxW = innerW - 12;
    const lines = pdf.splitTextToSize(bodyText, maxW);
    pdf.text(lines, textX, textY);

    // Footer (centralized): address + (optional phone) + date
    const footerLines = [];
    if (snap.address) footerLines.push(...String(snap.address).split("\n"));
    const showPhone = !!snap.showPhoneInPdf;
    const allowPhoneHere = ["recibo","orcamento","ficha"].includes(type);
    if (showPhone && allowPhoneHere && snap.phone) footerLines.push(`Contato: ${snap.phone}`);

    // date (always)
    footerLines.push(prettyDate(new Date(date+"T12:00:00")));

    pdf.setFontSize(9.5);
    pdf.setTextColor(40,40,40);
    const footerY = pageH - margin - (footerLines.length*4);
    let fy = footerY;
    footerLines.forEach(line => {
      pdf.text(String(line), pageW/2, fy, { align:"center" });
      fy += 4.2;
    });

    // filename
    const safePatient = (patient || "Paciente").replace(/[^a-zA-Z0-9\-_ ]/g,"").trim().replace(/\s+/g,"_");
    const file = `${label}_${safePatient}_${date}.pdf`;

    // Open visible PDF
    const blob = pdf.output("blob");
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank", "noopener");
    toast("PDF gerado.");
  }

  // -----------------------
  // Backup
  // -----------------------
  async function exportBackup(){
    const data = {
      exportedAt: nowISO(),
      profile: state.profile,
      patients: await idbAll("patients"),
      appointments: await idbAll("appointments"),
      documents: await idbAll("documents"),
      version: 1,
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type:"application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `backup_agenda_orlando_${new Date().toISOString().slice(0,10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast("Backup exportado.");
  }

  async function importBackup(file){
    try{
      const txt = await file.text();
      const data = JSON.parse(txt);

      if (!confirm("Importar backup vai MESCLAR dados. Continuar?")) return;

      if (data.profile){
        state.profile = { ...DEFAULT_PROFILE, ...data.profile };
        await setSetting("profile", state.profile);
        hydrateProfileUI();
        updateWelcomeAndWhats();
      }

      // Merge lists (naive): add all, preserving ids if possible
      await importList("patients", data.patients || []);
      await importList("appointments", data.appointments || []);
      await importList("documents", data.documents || []);

      toast("Backup importado.");
      await renderAll();
    }catch(e){
      console.error(e);
      toast("Falha ao importar. Arquivo inválido.");
    }
  }

  async function importList(store, items){
    if (!Array.isArray(items)) return;
    for (const item of items){
      // If has id, try put; else add.
      if (item && typeof item === "object"){
        if ("id" in item) await idbPut(store, item);
        else await idbAdd(store, item);
      }
    }
  }

  async function nukeAll(){
    await Promise.all([
      clearStore("patients"),
      clearStore("appointments"),
      clearStore("documents"),
    ]);
    state.selectedDate = isoDate(new Date());
    state.calCursor = new Date();
    state.docDraft = null;
    state.apptEditing = null;
  }

  function clearStore(store){
    return new Promise((resolve, reject) => {
      const s = tx(store, "readwrite");
      const r = s.clear();
      r.onsuccess = () => resolve(true);
      r.onerror = () => reject(r.error);
    });
  }

  // -----------------------
  // Small helpers
  // -----------------------
  function escapeHtml(s){
    return String(s ?? "")
      .replaceAll("&","&amp;")
      .replaceAll("<","&lt;")
      .replaceAll(">","&gt;")
      .replaceAll('"',"&quot;")
      .replaceAll("'","&#039;");
  }

  // -----------------------
  // Boot
  // -----------------------
  window.addEventListener("DOMContentLoaded", init);
})();
