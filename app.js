// BTX Agenda - navegação estável (sem etapa inicial bloqueadora)
const $ = (sel) => document.querySelector(sel);

const sidebar = $("#sidebar");
const btnMenu = $("#btnMenu");

btnMenu.addEventListener("click", () => {
  sidebar.classList.toggle("open");
});

// Event delegation: clique em qualquer botão do app sem travar
document.addEventListener("click", (e) => {
  const navbtn = e.target.closest("[data-view]");
  const actionbtn = e.target.closest("[data-action]");

  if (navbtn) {
    setView(navbtn.dataset.view);
    // fecha menu no mobile
    sidebar.classList.remove("open");
  }

  if (actionbtn) {
    handleAction(actionbtn.dataset.action);
  }
});

function setView(name){
  // ativa botão
  document.querySelectorAll(".navbtn").forEach(b => {
    b.classList.toggle("active", b.dataset.view === name);
  });

  // mostra view
  document.querySelectorAll(".view").forEach(v => v.classList.remove("show"));
  const view = $("#view-" + name);
  if (view) view.classList.add("show");
}

function handleAction(action){
  switch(action){
    case "save":
      toast("Salvo (demo).");
      break;
    case "pdf":
      // aqui você liga o gerador oficial de PDF (sem info de software)
      toast("PDF (demo).");
      break;

    case "novo-ag":
      toast("Novo agendamento (demo).");
      break;
    case "pdf-agenda":
      toast("PDF da agenda (demo).");
      break;

    case "novo-paciente":
      toast("Novo paciente (demo).");
      break;

    case "doc-receita":
    case "doc-atestado":
    case "doc-laudo":
    case "doc-orcamento":
      toast("Documento: " + action.replace("doc-","") + " (demo).");
      break;

    case "salvar-config":
      toast("Configurações salvas (demo).");
      break;
    case "backup":
      toast("Exportar backup (demo).");
      break;

    default:
      toast("Ação: " + action);
  }
}

// Toast simples, zero dependência
let toastTimer = null;
function toast(msg){
  let el = document.getElementById("toast");
  if (!el){
    el = document.createElement("div");
    el.id = "toast";
    el.style.position = "fixed";
    el.style.bottom = "16px";
    el.style.left = "50%";
    el.style.transform = "translateX(-50%)";
    el.style.padding = "10px 12px";
    el.style.borderRadius = "12px";
    el.style.border = "1px solid rgba(255,255,255,.12)";
    el.style.background = "rgba(0,0,0,.55)";
    el.style.color = "#fff";
    el.style.fontWeight = "700";
    el.style.zIndex = "999";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.display = "block";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.style.display = "none", 1400);
}
