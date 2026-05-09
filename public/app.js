const state = {
  currentUser: null,
  appointments: [],
  users: [],
  delivery: null,
  activeTab: "dashboard"
};

const elements = {};
const MAX_LOGO_FILE_SIZE_BYTES = 350 * 1024;

document.addEventListener("DOMContentLoaded", () => {
  cacheElements();
  bindEvents();
  initializeDefaultDate();
  bootstrap();
});

function cacheElements() {
  const ids = [
    "loginView",
    "appView",
    "loginForm",
    "loginUsername",
    "loginPassword",
    "loginFeedback",
    "brandLogoShell",
    "brandLogoImage",
    "brandIdentity",
    "currentUserName",
    "currentUserRole",
    "logoutButton",
    "refreshButton",
    "dashboardStats",
    "upcomingAppointments",
    "deliverySummary",
    "appointmentForm",
    "appointmentFormTitle",
    "appointmentId",
    "title",
    "service",
    "description",
    "clientName",
    "clientEmail",
    "clientPhone",
    "startAt",
    "endAt",
    "location",
    "notes",
    "status",
    "assignedUserId",
    "reminderEnabled",
    "reminderFields",
    "reminderHoursBefore",
    "reminderMessage",
    "saveAppointmentButton",
    "cancelAppointmentEdit",
    "appointmentFeedback",
    "appointmentsList",
    "userForm",
    "userFormTitle",
    "userEditId",
    "userFullName",
    "userUsername",
    "userPassword",
    "userPasswordHelp",
    "userRole",
    "userRoleHelp",
    "userLogoField",
    "userLogoFile",
    "userSubmitButton",
    "userCancelEdit",
    "userFeedback",
    "usersList",
    "deliveryChannels",
    "whatsappBranchPanel",
    "whatsappBranchForm",
    "whatsappProviderMode",
    "whatsappBranchModeHint",
    "whatsappMetaSettings",
    "whatsappMetaAccessToken",
    "whatsappMetaPhoneNumberId",
    "whatsappMetaDisplayPhoneNumber",
    "whatsappMetaWabaId",
    "whatsappMetaBusinessAccountId",
    "whatsappBranchSaveButton",
    "whatsappBranchFeedback",
    "brandingPanel",
    "brandingManagerSection",
    "brandingForm",
    "brandingTargetAdminId",
    "brandingLogoFile",
    "removeBrandingButton",
    "brandingPreview",
    "brandingPreviewImage",
    "brandingDescription",
    "brandingFeedback"
  ];

  for (const id of ids) {
    elements[id] = document.getElementById(id);
  }
}

function bindEvents() {
  elements.loginForm.addEventListener("submit", handleLogin);
  elements.logoutButton.addEventListener("click", handleLogout);
  elements.refreshButton.addEventListener("click", loadAppData);
  elements.appointmentForm.addEventListener("submit", handleAppointmentSubmit);
  elements.cancelAppointmentEdit.addEventListener("click", resetAppointmentForm);
  elements.userForm.addEventListener("submit", handleUserSubmit);
  elements.userCancelEdit.addEventListener("click", resetUserForm);
  elements.userRole.addEventListener("change", updateUserLogoFieldState);
  elements.reminderEnabled.addEventListener("change", updateReminderFieldsState);
  elements.whatsappBranchForm.addEventListener("submit", handleWhatsappBranchSubmit);
  elements.whatsappProviderMode.addEventListener("change", updateWhatsappProviderModeFields);
  elements.brandingForm.addEventListener("submit", handleBrandingSubmit);
  elements.removeBrandingButton.addEventListener("click", handleBrandingRemove);
  elements.brandingTargetAdminId.addEventListener("change", renderBrandingManager);
  document.querySelectorAll(".tab-button").forEach((button) => {
    button.addEventListener("click", () => switchTab(button.dataset.tab));
  });

  elements.appointmentsList.addEventListener("click", handleAppointmentListClick);
  elements.usersList.addEventListener("click", handleUsersListClick);
}

async function bootstrap() {
  if (window.location.protocol === "file:") {
    showLogin();
    setFeedback(
      elements.loginFeedback,
      "Apri la piattaforma da http://localhost:3000 dopo aver avviato npm start. Con il doppio clic si caricano solo i file statici, non login e API.",
      true
    );
    const submitButton = elements.loginForm.querySelector('button[type="submit"]');
    if (submitButton) {
      submitButton.disabled = true;
    }
    return;
  }

  try {
    const response = await api("/api/auth/me");
    state.currentUser = response.user;
    state.delivery = response.delivery;
    showApp();
    await loadAppData();
  } catch (error) {
    showLogin();
  }
}

async function handleLogin(event) {
  event.preventDefault();
  setFeedback(elements.loginFeedback, "");

  try {
    const response = await api("/api/auth/login", {
      method: "POST",
      body: {
        username: elements.loginUsername.value,
        password: elements.loginPassword.value
      }
    });

    state.currentUser = response.user;
    state.delivery = response.delivery;
    elements.loginForm.reset();
    showApp();
    await loadAppData();
  } catch (error) {
    setFeedback(elements.loginFeedback, error.message, true);
  }
}

async function handleLogout() {
  try {
    await api("/api/auth/logout", { method: "POST" });
  } catch (error) {
    console.error(error);
  }

  state.currentUser = null;
  state.appointments = [];
  state.users = [];
  state.delivery = null;
  showLogin();
}

async function loadAppData() {
  if (!state.currentUser) {
    return;
  }

  const requests = [api("/api/auth/me"), api("/api/appointments"), api("/api/settings/delivery")];
  if (state.currentUser.role === "admin") {
    requests.push(api("/api/users"));
  }

  const [meResponse, appointmentsResponse, deliveryResponse, usersResponse] = await Promise.all(requests);
  state.currentUser = meResponse.user;
  state.appointments = appointmentsResponse.appointments || [];
  state.delivery = deliveryResponse.delivery;
  state.users = usersResponse ? usersResponse.users || [] : [state.currentUser];

  if (state.currentUser.role !== "admin" && !state.users.length) {
    state.users = [state.currentUser];
  }

  render();
}

function render() {
  renderBrandPanel();
  renderHeader();
  renderTabs();
  renderDashboard();
  renderUsers();
  renderDelivery();
  renderWhatsappBranchSettings();
  renderAppointments();
  renderBrandingManager();
  updateReminderFieldsState();
  updateUserLogoFieldState();
  updateUserFormMode();
}

function renderHeader() {
  elements.currentUserName.textContent =
    state.currentUser.fullName || state.currentUser.username || "Utente";
  elements.currentUserRole.textContent = state.currentUser.role.toUpperCase();
}

function renderBrandPanel() {
  const effectiveLogo = state.currentUser && state.currentUser.effectiveLogoDataUrl;
  const ownerLabel =
    state.currentUser && state.currentUser.ownerAdminName
      ? state.currentUser.ownerAdminName
      : state.currentUser && state.currentUser.fullName
        ? state.currentUser.fullName
        : "";

  if (effectiveLogo) {
    elements.brandLogoImage.src = effectiveLogo;
    elements.brandLogoShell.classList.remove("hidden");
  } else {
    elements.brandLogoImage.removeAttribute("src");
    elements.brandLogoShell.classList.add("hidden");
  }

  if (!state.currentUser) {
    elements.brandIdentity.textContent = "";
    elements.brandIdentity.classList.add("hidden");
    return;
  }

  elements.brandIdentity.textContent =
    state.currentUser.role === "admin"
      ? `Brand admin: ${ownerLabel}`
      : `Logo assegnato da: ${ownerLabel || "Admin"}`;
  elements.brandIdentity.classList.remove("hidden");
}

function renderTabs() {
  const isAdmin = state.currentUser.role === "admin";
  document.querySelectorAll(".admin-only").forEach((node) => {
    node.classList.toggle("hidden", !isAdmin);
  });
  if (!isAdmin && state.activeTab === "users") {
    switchTab("dashboard");
  }
}

function switchTab(tabName) {
  state.activeTab = tabName;
  document.querySelectorAll(".tab-button").forEach((button) => {
    button.classList.toggle("active", button.dataset.tab === tabName);
  });
  document.querySelectorAll(".tab-panel").forEach((panel) => {
    panel.classList.toggle("active", panel.id === `${tabName}Tab`);
  });
}

function renderDashboard() {
  const now = Date.now();
  const appointments = [...state.appointments];
  const scheduled = appointments.filter((item) => item.status === "scheduled");
  const todayCount = scheduled.filter((item) => isSameDay(item.startAt, new Date())).length;
  const pendingReminders = scheduled.filter((item) => {
    return item.reminderEnabled && item.pendingReminderChannels && item.pendingReminderChannels.length;
  }).length;

  const stats = [
    {
      label: "Appuntamenti totali",
      value: appointments.length
    },
    {
      label: "Programmato oggi",
      value: todayCount
    },
    {
      label: "Da completare",
      value: scheduled.length
    },
    {
      label: "Reminder aperti",
      value: pendingReminders
    }
  ];

  elements.dashboardStats.innerHTML = stats
    .map((stat) => {
      return `
        <article class="stat-card">
          <span>${escapeHtml(stat.label)}</span>
          <strong>${stat.value}</strong>
        </article>
      `;
    })
    .join("");

  const upcoming = scheduled
    .filter((item) => new Date(item.startAt).getTime() >= now)
    .sort((left, right) => new Date(left.startAt) - new Date(right.startAt))
    .slice(0, 6);

  elements.upcomingAppointments.innerHTML = upcoming.length
    ? upcoming
        .map((appointment) => {
          return `
            <article class="compact-card">
              <strong>${escapeHtml(appointment.title)}</strong>
              <span>${escapeHtml(appointment.clientName)}</span>
              <span>${formatDateTime(appointment.startAt)}</span>
              <span>${escapeHtml(appointment.assignedUserName || "-")}</span>
            </article>
          `;
        })
        .join("")
    : `<p class="muted">Nessun appuntamento imminente.</p>`;

  const summary = state.delivery
    ? Object.entries(state.delivery.channels)
        .map(([channel, config]) => {
          return `
            <article class="compact-card">
              <strong>${channel.toUpperCase()}</strong>
              <span>${config.mode === "live" ? "Attivo" : config.mode === "mock" ? "Mock" : "Disattivo"}</span>
              <span>${escapeHtml(config.provider)}</span>
            </article>
          `;
        })
        .join("")
    : `<p class="muted">Config reminder non disponibile.</p>`;

  elements.deliverySummary.innerHTML = summary;
}

function renderAppointments() {
  fillAssignedUsers();

  const appointments = [...state.appointments].sort(
    (left, right) => new Date(left.startAt) - new Date(right.startAt)
  );

  elements.appointmentsList.innerHTML = appointments.length
    ? appointments
        .map((appointment) => {
          const reminderChannels = appointment.reminderChannels || [];
          const statusLabel = mapAppointmentStatus(appointment.status);
          const lastReminder = appointment.reminderLogs && appointment.reminderLogs[0];

          return `
            <article class="appointment-card status-${appointment.status}">
              <div class="appointment-top">
                <div>
                  <span class="status-pill">${escapeHtml(statusLabel)}</span>
                  <h4>${escapeHtml(appointment.title)}</h4>
                </div>
                <div class="card-actions">
                  <button class="inline-button" data-action="edit" data-id="${appointment.id}" type="button">Modifica</button>
                  <button
                    class="inline-button"
                    data-action="send-reminder"
                    data-id="${appointment.id}"
                    type="button"
                    ${appointment.reminderEnabled ? "" : "disabled"}
                  >
                    Invia remind
                  </button>
                  <button class="inline-button danger" data-action="delete" data-id="${appointment.id}" type="button">Elimina</button>
                </div>
              </div>

              <div class="appointment-meta">
                <span><strong>Cliente:</strong> ${escapeHtml(appointment.clientName)}</span>
                <span><strong>Servizio:</strong> ${escapeHtml(appointment.service)}</span>
                <span><strong>Inizio:</strong> ${formatDateTime(appointment.startAt)}</span>
                <span><strong>Luogo:</strong> ${escapeHtml(appointment.location || "-")}</span>
                <span><strong>Assegnato a:</strong> ${escapeHtml(appointment.assignedUserName || "-")}</span>
                <span><strong>Creato da:</strong> ${escapeHtml(appointment.createdByName || "-")}</span>
              </div>

              <div class="appointment-bottom">
                <div class="channel-tags">
                  ${reminderChannels.length
                    ? reminderChannels
                        .map((channel) => `<span class="tag">${escapeHtml(channel)}</span>`)
                        .join("")
                    : `<span class="muted">Nessun reminder</span>`}
                </div>
                <div class="small-meta">
                  ${
                    appointment.reminderEnabled
                      ? `<span>Invio previsto: ${formatDateTime(appointment.reminderDueAt)}</span>`
                      : `<span>Reminder disattivato</span>`
                  }
                  ${
                    lastReminder
                      ? `<span>Ultimo invio: ${escapeHtml(lastReminder.status)} - ${formatDateTime(
                          lastReminder.attemptedAt
                        )}</span>`
                      : `<span>Nessun invio registrato</span>`
                  }
                </div>
              </div>
            </article>
          `;
        })
        .join("")
    : `<p class="muted">Nessun appuntamento presente.</p>`;
}

function renderUsers() {
  if (state.currentUser.role !== "admin") {
    elements.usersList.innerHTML = `<p class="muted">Solo gli admin possono gestire utenti.</p>`;
    return;
  }

  elements.usersList.innerHTML = state.users
    .map((user) => {
      return `
        <article class="user-card">
          <div class="user-card-top">
            <div>
              <strong>${escapeHtml(user.fullName)}</strong>
              <span>${escapeHtml(user.username)}</span>
            </div>
            ${
              user.effectiveLogoDataUrl
                ? `<img class="user-logo-thumb" src="${user.effectiveLogoDataUrl}" alt="Logo ${escapeHtml(
                    user.fullName
                  )}" />`
                : ""
            }
          </div>
          <span>${escapeHtml(user.role.toUpperCase())}${user.isPlatformOwner ? " - PRINCIPALE" : ""}</span>
          <span>Creato da: ${escapeHtml(user.createdByName || user.fullName)}</span>
          <span>Admin proprietario: ${escapeHtml(user.ownerAdminName || user.fullName)}</span>
          <div class="user-card-actions">
            <button
              class="inline-button"
              data-action="edit-user"
              data-id="${user.id}"
              type="button"
              ${canCurrentUserManageUser(user) ? "" : "disabled"}
            >
              Modifica
            </button>
            <button
              class="inline-button danger"
              data-action="delete-user"
              data-id="${user.id}"
              type="button"
              ${canCurrentUserDeleteUser(user) ? "" : "disabled"}
            >
              Elimina
            </button>
          </div>
        </article>
      `;
    })
    .join("");
}

function renderBrandingManager() {
  const isPlatformOwner = Boolean(state.currentUser && state.currentUser.isPlatformOwner);
  elements.brandingPanel.classList.toggle("hidden", !isPlatformOwner);
  elements.brandingManagerSection.classList.toggle("hidden", !isPlatformOwner);

  if (!isPlatformOwner) {
    return;
  }

  const adminTargets = state.users.filter((user) => {
    return user.role === "admin" && !user.isPlatformOwner && user.isBrandOwner;
  });

  const currentValue = elements.brandingTargetAdminId.value;
  elements.brandingTargetAdminId.innerHTML = adminTargets.length
    ? adminTargets
        .map((user) => `<option value="${user.id}">${escapeHtml(user.fullName)}</option>`)
        .join("")
    : `<option value="">Nessun admin disponibile</option>`;

  if (adminTargets.some((user) => user.id === currentValue)) {
    elements.brandingTargetAdminId.value = currentValue;
  } else if (adminTargets.length) {
    elements.brandingTargetAdminId.value = adminTargets[0].id;
  } else {
    elements.brandingTargetAdminId.value = "";
  }

  const targetAdmin = adminTargets.find((user) => user.id === elements.brandingTargetAdminId.value) || null;
  const controlsDisabled = !targetAdmin;
  elements.brandingTargetAdminId.disabled = controlsDisabled;
  elements.brandingLogoFile.disabled = controlsDisabled;
  elements.removeBrandingButton.disabled = controlsDisabled;
  elements.brandingForm.querySelector('button[type="submit"]').disabled = controlsDisabled;

  const hasLogo = Boolean(targetAdmin && targetAdmin.logoDataUrl);
  if (hasLogo) {
    elements.brandingPreviewImage.src = targetAdmin.logoDataUrl;
    elements.brandingPreview.classList.remove("hidden");
    elements.brandingDescription.textContent =
      `Il logo di ${targetAdmin.fullName} verra ereditato da tutti gli utenti creati da questo ramo.`;
  } else {
    elements.brandingPreviewImage.removeAttribute("src");
    elements.brandingPreview.classList.add("hidden");
    elements.brandingDescription.textContent = targetAdmin
      ? `Nessun logo impostato per ${targetAdmin.fullName}. Caricane uno per applicarlo a tutto il ramo.`
      : "Non ci sono ancora account admin gestibili a cui assegnare un logo.";
  }
}

function renderDelivery() {
  if (!state.delivery) {
    elements.deliveryChannels.innerHTML = `<p class="muted">Nessuna configurazione trovata.</p>`;
    return;
  }

  elements.deliveryChannels.innerHTML = Object.entries(state.delivery.channels)
    .map(([channel, config]) => {
      const modeLabel =
        config.mode === "live"
          ? "Attivo"
          : config.mode === "mock"
            ? "Mock locale"
            : config.mode === "setup"
              ? "Da completare"
              : "Disattivo";
      const modeClass =
        config.mode === "live"
          ? "channel-mode-live"
          : config.mode === "mock"
            ? "channel-mode-mock"
            : config.mode === "setup"
              ? "channel-mode-setup"
              : "channel-mode-off";
      const description =
        config.mode === "live"
          ? "Invio reale attivo tramite provider configurato."
          : config.mode === "mock"
            ? "Invio simulato per test interni, senza spedizione reale."
            : config.mode === "setup"
              ? "Il canale e impostato sul provider del cliente ma i dati Meta non sono ancora completi."
              : "Canale non configurato. Nessun invio disponibile.";

      return `
        <article class="channel-card">
          <div class="channel-card-head">
            <div class="channel-card-title">
              <span class="channel-label">Canale</span>
              <strong class="channel-name">${escapeHtml(formatChannelLabel(channel))}</strong>
            </div>
            <span class="channel-mode-badge ${modeClass}">${escapeHtml(modeLabel)}</span>
          </div>
          <p class="channel-description">${escapeHtml(description)}</p>
          <p class="channel-provider">
            <span>Provider</span>
            <strong>${escapeHtml(config.provider)}</strong>
          </p>
        </article>
      `;
    })
    .join("");
}

function renderWhatsappBranchSettings() {
  const branchConfig = state.delivery && state.delivery.whatsappBranchConfig;
  if (!branchConfig) {
    elements.whatsappBranchPanel.classList.add("hidden");
    return;
  }

  elements.whatsappBranchPanel.classList.remove("hidden");
  elements.whatsappProviderMode.value = branchConfig.whatsappMode || "system";
  elements.whatsappMetaPhoneNumberId.value = branchConfig.metaPhoneNumberId || "";
  elements.whatsappMetaDisplayPhoneNumber.value = branchConfig.metaDisplayPhoneNumber || "";
  elements.whatsappMetaWabaId.value = branchConfig.metaWabaId || "";
  elements.whatsappMetaBusinessAccountId.value = branchConfig.metaBusinessAccountId || "";
  elements.whatsappMetaAccessToken.value = "";
  elements.whatsappMetaAccessToken.placeholder = branchConfig.hasStoredMetaAccessToken
    ? "Gia salvato. Inseriscine uno nuovo solo se vuoi sostituirlo."
    : "Incolla qui il token permanente di Meta";

  const managedByName = branchConfig.branchOwnerName || "l'admin del ramo";
  if (branchConfig.canManage) {
    elements.whatsappBranchModeHint.textContent =
      branchConfig.whatsappMode === "meta_cloud"
        ? "Questo ramo usa il proprio account Meta: i costi WhatsApp restano sul cliente. Puoi tornare al provider attuale in qualsiasi momento."
        : "Questo ramo sta usando il provider WhatsApp attuale della piattaforma. Se vuoi, puoi passare all'account Meta del cliente senza perdere il fallback.";
  } else {
    elements.whatsappBranchModeHint.textContent =
      branchConfig.whatsappMode === "meta_cloud"
        ? `Il canale WhatsApp di questo ramo e gestito da ${managedByName} con billing diretto del cliente.`
        : `Il canale WhatsApp di questo ramo usa ancora il provider attuale della piattaforma ed e gestito da ${managedByName}.`;
  }

  elements.whatsappBranchForm
    .querySelectorAll("input, select, button")
    .forEach((field) => (field.disabled = !branchConfig.canManage));

  updateWhatsappProviderModeFields();
}

function updateWhatsappProviderModeFields() {
  const branchConfig = state.delivery && state.delivery.whatsappBranchConfig;
  const showMetaSettings = elements.whatsappProviderMode.value === "meta_cloud";
  elements.whatsappMetaSettings.classList.toggle("hidden", !showMetaSettings);

  if (!branchConfig || !branchConfig.canManage) {
    elements.whatsappBranchSaveButton.textContent = "Configurazione gestita dal ramo";
    return;
  }

  if (showMetaSettings) {
    elements.whatsappBranchSaveButton.textContent = "Attiva Meta Cloud del cliente";
  } else {
    elements.whatsappBranchSaveButton.textContent = "Ripristina provider attuale";
  }
}

function formatChannelLabel(channel) {
  const normalized = String(channel || "").trim().toLowerCase();
  if (normalized === "email") {
    return "Email";
  }
  if (normalized === "sms") {
    return "SMS";
  }
  if (normalized === "whatsapp") {
    return "WhatsApp";
  }
  return normalized ? normalized.charAt(0).toUpperCase() + normalized.slice(1) : "Canale";
}

function fillAssignedUsers() {
  const users = state.currentUser.role === "admin" ? state.users : [state.currentUser];
  elements.assignedUserId.innerHTML = users
    .map((user) => {
      return `<option value="${user.id}">${escapeHtml(user.fullName)} (${escapeHtml(
        user.role
      )})</option>`;
    })
    .join("");

  if (!elements.appointmentId.value) {
    elements.assignedUserId.value = state.currentUser.id;
  }
}

async function handleAppointmentSubmit(event) {
  event.preventDefault();
  setFeedback(elements.appointmentFeedback, "");

  const appointmentId = elements.appointmentId.value;
  const channels = Array.from(document.querySelectorAll('input[name="channel"]:checked')).map(
    (input) => input.value
  );

  const payload = {
    title: elements.title.value,
    service: elements.service.value,
    description: elements.description.value,
    clientName: elements.clientName.value,
    clientEmail: elements.clientEmail.value,
    clientPhone: elements.clientPhone.value,
    startAt: toIsoString(elements.startAt.value),
    endAt: elements.endAt.value ? toIsoString(elements.endAt.value) : "",
    location: elements.location.value,
    notes: elements.notes.value,
    status: elements.status.value,
    assignedUserId: elements.assignedUserId.value,
    reminderEnabled: elements.reminderEnabled.checked,
    reminderMinutesBefore: hoursToMinutes(elements.reminderHoursBefore.value),
    reminderChannels: channels,
    reminderMessage: elements.reminderMessage.value
  };

  const endpoint = appointmentId ? `/api/appointments/${appointmentId}` : "/api/appointments";
  const method = appointmentId ? "PUT" : "POST";

  try {
    await api(endpoint, { method, body: payload });
    setFeedback(
      elements.appointmentFeedback,
      appointmentId ? "Appuntamento aggiornato con successo." : "Appuntamento creato con successo."
    );
    resetAppointmentForm();
    await loadAppData();
    switchTab("appointments");
  } catch (error) {
    setFeedback(elements.appointmentFeedback, error.message, true);
  }
}

async function handleUserSubmit(event) {
  event.preventDefault();
  setFeedback(elements.userFeedback, "");

  try {
    const isEditing = Boolean(elements.userEditId.value);
    const logoDataUrl =
      !isEditing && elements.userRole.value === "admin"
        ? await getOptionalImageDataUrl(elements.userLogoFile)
        : null;

    await api(isEditing ? `/api/users/${elements.userEditId.value}` : "/api/users", {
      method: isEditing ? "PUT" : "POST",
      body: {
        fullName: elements.userFullName.value,
        username: elements.userUsername.value,
        password: elements.userPassword.value,
        role: elements.userRole.value,
        logoDataUrl
      }
    });

    resetUserForm();
    setFeedback(
      elements.userFeedback,
      isEditing ? "Utente aggiornato correttamente." : "Utente creato correttamente."
    );
    await loadAppData();
  } catch (error) {
    setFeedback(elements.userFeedback, error.message, true);
  }
}

async function handleUsersListClick(event) {
  const button = event.target.closest("button[data-action]");
  if (!button) {
    return;
  }

  const user = state.users.find((entry) => entry.id === button.dataset.id);
  if (!user) {
    return;
  }

  if (button.dataset.action === "edit-user") {
    populateUserForm(user);
    return;
  }

  if (button.dataset.action === "delete-user") {
    if (!canCurrentUserDeleteUser(user)) {
      return;
    }

    const confirmed = window.confirm(
      `Vuoi eliminare definitivamente l'account di ${user.fullName}? Questa azione non e reversibile.`
    );
    if (!confirmed) {
      return;
    }

    try {
      await api(`/api/users/${user.id}`, { method: "DELETE" });
      if (state.currentUser && state.currentUser.id === user.id) {
        await handleLogout();
        return;
      }
      resetUserForm();
      await loadAppData();
    } catch (error) {
      window.alert(error.message);
    }
  }
}

async function handleWhatsappBranchSubmit(event) {
  event.preventDefault();
  setFeedback(elements.whatsappBranchFeedback, "");

  try {
    const mode = elements.whatsappProviderMode.value;
    const response = await api("/api/settings/whatsapp-branch", {
      method: "PUT",
      body: {
        mode,
        metaAccessToken: elements.whatsappMetaAccessToken.value,
        metaPhoneNumberId: elements.whatsappMetaPhoneNumberId.value,
        metaDisplayPhoneNumber: elements.whatsappMetaDisplayPhoneNumber.value,
        metaWabaId: elements.whatsappMetaWabaId.value,
        metaBusinessAccountId: elements.whatsappMetaBusinessAccountId.value
      }
    });

    state.delivery = response.delivery;
    renderDelivery();
    renderWhatsappBranchSettings();
    setFeedback(
      elements.whatsappBranchFeedback,
      mode === "meta_cloud"
        ? "WhatsApp del cliente attivato. Da ora questo ramo usa Meta Cloud API con billing diretto sul cliente."
        : "Ripristinato il provider WhatsApp attuale della piattaforma per questo ramo."
    );
  } catch (error) {
    setFeedback(elements.whatsappBranchFeedback, error.message, true);
  }
}

async function handleBrandingSubmit(event) {
  event.preventDefault();
  setFeedback(elements.brandingFeedback, "");

  try {
    const targetAdminId = elements.brandingTargetAdminId.value;
    if (!targetAdminId) {
      throw new Error("Seleziona prima un account admin.");
    }

    const logoDataUrl = await getOptionalImageDataUrl(elements.brandingLogoFile);
    if (!logoDataUrl) {
      throw new Error("Seleziona un file immagine prima di salvare il logo.");
    }

    await api("/api/branding", {
      method: "PUT",
      body: {
        targetAdminId,
        logoDataUrl
      }
    });

    elements.brandingForm.reset();
    setFeedback(elements.brandingFeedback, "Logo admin aggiornato con successo.");
    await loadAppData();
  } catch (error) {
    setFeedback(elements.brandingFeedback, error.message, true);
  }
}

async function handleBrandingRemove() {
  setFeedback(elements.brandingFeedback, "");

  try {
    const targetAdminId = elements.brandingTargetAdminId.value;
    if (!targetAdminId) {
      throw new Error("Seleziona prima un account admin.");
    }

    await api("/api/branding", {
      method: "PUT",
      body: {
        targetAdminId,
        logoDataUrl: null
      }
    });

    elements.brandingForm.reset();
    setFeedback(elements.brandingFeedback, "Logo admin rimosso.");
    await loadAppData();
  } catch (error) {
    setFeedback(elements.brandingFeedback, error.message, true);
  }
}

function populateUserForm(user) {
  elements.userFormTitle.textContent = "Modifica utente";
  elements.userEditId.value = user.id;
  elements.userFullName.value = user.fullName || "";
  elements.userUsername.value = user.username || "";
  elements.userPassword.value = "";
  elements.userRole.value = user.role || "user";
  setFeedback(elements.userFeedback, `Stai modificando l'account di ${user.fullName}.`);
  updateUserFormMode();
  switchTab("users");
  focusUserForm();
}

function resetUserForm() {
  elements.userForm.reset();
  elements.userEditId.value = "";
  elements.userRole.value = "user";
  setFeedback(elements.userFeedback, "");
  updateUserFormMode();
}

function updateUserFormMode() {
  const isEditing = Boolean(elements.userEditId.value);
  elements.userFormTitle.textContent = isEditing ? "Modifica utente" : "Crea utente";
  elements.userSubmitButton.textContent = isEditing ? "Salva modifiche" : "Crea utente";
  elements.userCancelEdit.classList.toggle("hidden", !isEditing);
  elements.userPassword.required = !isEditing;
  elements.userPassword.minLength = isEditing ? 0 : 6;
  elements.userPasswordHelp.classList.toggle("hidden", !isEditing);
  elements.userRoleHelp.classList.toggle("hidden", !isEditing);
  elements.userRole.disabled = isEditing;
  if (!isEditing) {
    elements.userPassword.placeholder = "";
  } else {
    elements.userPassword.placeholder = "Nuova password opzionale";
  }
  updateUserLogoFieldState();
}

function focusUserForm() {
  window.requestAnimationFrame(() => {
    const formPanel = elements.userForm.closest(".panel");
    if (formPanel) {
      formPanel.classList.remove("form-spotlight");
      void formPanel.offsetWidth;
      formPanel.classList.add("form-spotlight");
      window.setTimeout(() => formPanel.classList.remove("form-spotlight"), 1800);
    }

    elements.userForm.scrollIntoView({
      behavior: "smooth",
      block: "start"
    });
    elements.userFullName.focus();
    elements.userFullName.select();
  });
}

async function handleAppointmentListClick(event) {
  const button = event.target.closest("button[data-action]");
  if (!button) {
    return;
  }

  const appointment = state.appointments.find((item) => item.id === button.dataset.id);
  if (!appointment) {
    return;
  }

  if (button.dataset.action === "edit") {
    populateAppointmentForm(appointment);
    switchTab("appointments");
    return;
  }

  if (button.dataset.action === "delete") {
    const confirmed = window.confirm("Vuoi eliminare definitivamente questo appuntamento?");
    if (!confirmed) {
      return;
    }

    try {
      await api(`/api/appointments/${appointment.id}`, { method: "DELETE" });
      await loadAppData();
    } catch (error) {
      window.alert(error.message);
    }
    return;
  }

  if (button.dataset.action === "send-reminder") {
    try {
      await api(`/api/appointments/${appointment.id}/send-reminder`, { method: "POST" });
      await loadAppData();
      window.alert("Reminder inviato.");
    } catch (error) {
      window.alert(error.message);
    }
  }
}

function populateAppointmentForm(appointment) {
  elements.appointmentFormTitle.textContent = "Modifica appuntamento";
  elements.appointmentId.value = appointment.id;
  elements.title.value = appointment.title || "";
  elements.service.value = appointment.service || "";
  elements.description.value = appointment.description || "";
  elements.clientName.value = appointment.clientName || "";
  elements.clientEmail.value = appointment.clientEmail || "";
  elements.clientPhone.value = appointment.clientPhone || "";
  elements.startAt.value = toDateTimeLocalValue(appointment.startAt);
  elements.endAt.value = appointment.endAt ? toDateTimeLocalValue(appointment.endAt) : "";
  elements.location.value = appointment.location || "";
  elements.notes.value = appointment.notes || "";
  elements.status.value = appointment.status || "scheduled";
  elements.assignedUserId.value = appointment.assignedUserId || state.currentUser.id;
  elements.reminderEnabled.checked = Boolean(appointment.reminderEnabled);
  elements.reminderHoursBefore.value = minutesToHoursValue(appointment.reminderMinutesBefore);
  elements.reminderMessage.value = appointment.reminderMessage || "";
  document.querySelectorAll('input[name="channel"]').forEach((input) => {
    input.checked = (appointment.reminderChannels || []).includes(input.value);
  });
  updateReminderFieldsState();
  elements.cancelAppointmentEdit.classList.remove("hidden");
}

function resetAppointmentForm() {
  elements.appointmentForm.reset();
  elements.appointmentFormTitle.textContent = "Crea appuntamento";
  elements.appointmentId.value = "";
  elements.reminderHoursBefore.value = 1;
  initializeDefaultDate();
  updateReminderFieldsState();
  document.querySelectorAll('input[name="channel"]').forEach((input) => {
    input.checked = false;
  });
  elements.cancelAppointmentEdit.classList.add("hidden");
  setFeedback(elements.appointmentFeedback, "");
  if (state.currentUser) {
    elements.assignedUserId.value = state.currentUser.id;
  }
}

function hoursToMinutes(value) {
  const hours = Number(value || 0);
  if (!Number.isFinite(hours) || hours < 0) {
    return 0;
  }
  return Math.round(hours * 60);
}

function minutesToHoursValue(value) {
  const minutes = Number(value);
  if (!Number.isFinite(minutes)) {
    return 1;
  }
  return minutes / 60;
}

function updateUserLogoFieldState() {
  const showLogoField =
    state.currentUser &&
    state.currentUser.isPlatformOwner &&
    elements.userRole.value === "admin" &&
    !elements.userEditId.value;
  elements.userLogoField.classList.toggle("hidden", !showLogoField);
  elements.userLogoFile.disabled = !showLogoField;
  if (!showLogoField) {
    elements.userLogoFile.value = "";
  }
}

function canCurrentUserManageUser(user) {
  if (!state.currentUser || state.currentUser.role !== "admin") {
    return false;
  }

  if (state.currentUser.isPlatformOwner) {
    return true;
  }

  if (user.isPlatformOwner) {
    return false;
  }

  if (state.currentUser.id === user.id) {
    return true;
  }

  return user.createdByUserId === state.currentUser.id;
}

function canCurrentUserDeleteUser(user) {
  return canCurrentUserManageUser(user) && !user.isPlatformOwner;
}

function updateReminderFieldsState() {
  const enabled = elements.reminderEnabled.checked;
  elements.reminderFields.classList.toggle("disabled", !enabled);
  elements.reminderFields
    .querySelectorAll("input, textarea")
    .forEach((field) => (field.disabled = !enabled));
}

function initializeDefaultDate() {
  const nextHour = new Date();
  nextHour.setMinutes(0, 0, 0);
  nextHour.setHours(nextHour.getHours() + 1);
  elements.startAt.value = toDateTimeLocalValue(nextHour.toISOString());
  elements.endAt.value = "";
}

function showLogin() {
  elements.loginView.classList.remove("hidden");
  elements.appView.classList.add("hidden");
  renderBrandPanel();
}

function showApp() {
  elements.loginView.classList.add("hidden");
  elements.appView.classList.remove("hidden");
}

async function getOptionalImageDataUrl(inputElement) {
  const file = inputElement.files && inputElement.files[0];
  if (!file) {
    return null;
  }

  return readImageFileAsDataUrl(file);
}

async function readImageFileAsDataUrl(file) {
  if (!file.type.startsWith("image/")) {
    throw new Error("Seleziona un file immagine valido.");
  }

  if (file.size > MAX_LOGO_FILE_SIZE_BYTES) {
    throw new Error("Il logo e troppo grande. Usa un file immagine entro 350 KB.");
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Impossibile leggere il file immagine selezionato."));
    reader.readAsDataURL(file);
  });
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    method: options.method || "GET",
    headers: {
      "Content-Type": "application/json"
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || "Operazione non riuscita");
  }

  return payload;
}

function setFeedback(element, message, isError = false) {
  element.textContent = message;
  element.classList.toggle("error", Boolean(message) && isError);
  element.classList.toggle("success", Boolean(message) && !isError);
}

function mapAppointmentStatus(status) {
  if (status === "completed") {
    return "Completato";
  }
  if (status === "cancelled") {
    return "Annullato";
  }
  return "Programmato";
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatDateTime(value) {
  if (!value) {
    return "-";
  }

  const date = new Date(value);
  return new Intl.DateTimeFormat("it-IT", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}

function toDateTimeLocalValue(value) {
  const date = new Date(value);
  const offset = date.getTimezoneOffset();
  const localDate = new Date(date.getTime() - offset * 60 * 1000);
  return localDate.toISOString().slice(0, 16);
}

function toIsoString(value) {
  return new Date(value).toISOString();
}

function isSameDay(value, comparisonDate) {
  const date = new Date(value);
  return (
    date.getDate() === comparisonDate.getDate() &&
    date.getMonth() === comparisonDate.getMonth() &&
    date.getFullYear() === comparisonDate.getFullYear()
  );
}
