document.addEventListener('DOMContentLoaded', async () => {
  /* ------------------------------------------------------------------
     DOM References
  ------------------------------------------------------------------ */
  const loginBtn        = document.getElementById('loginBtn');
  const logoutBtn       = document.getElementById('logoutBtn');
  const errorDiv        = document.getElementById('error');

  // Room tabs
  const roomTabs        = document.getElementById('roomTabs');
  const roomTabContent  = document.getElementById('roomTabContent');

  // Popup elements
  const eventPopup      = document.getElementById('eventPopup');
  const popupTitle      = document.getElementById('popupTitle');
  const popupTimeStart  = document.getElementById('popupTimeStart');
  const popupTimeEnd    = document.getElementById('popupTimeEnd');
  const popupOrganizer  = document.getElementById('popupOrganizer');
  const popupAttendees  = document.getElementById('popupAttendees');

  const editEventBtn    = document.getElementById('editEvent');
  const deleteEventBtn  = document.getElementById('deleteEvent');
  const closePopupBtn   = document.getElementById('closePopup');

  // Modal references
  const eventModal      = new bootstrap.Modal(document.getElementById('eventModal'), {});
  const eventForm       = document.getElementById('eventForm');
  const calendarIdField = document.getElementById('calendarId');
  const eventIdField    = document.getElementById('eventId');
  const eventTitleField = document.getElementById('eventTitle');
  const eventStartField = document.getElementById('eventStart'); // <input type="datetime-local">
  const eventEndField   = document.getElementById('eventEnd');   // <input type="datetime-local">
  const eventGuestsField= document.getElementById('eventGuests');

  // Track state
  let isPopupVisible    = false;
  const calendars       = {};      // { calendarId: FullCalendar instance }
  const lastKnownVersions = {};    // { calendarId: number }

  /* ------------------------------------------------------------------
     1) Check if user is logged in
  ------------------------------------------------------------------ */
  let isLoggedIn = false;
  try {
    const meRes = await fetch('/api/me');
    if (meRes.status === 200) {
      isLoggedIn = true;
    }
  } catch (err) {
    console.error('Error checking /api/me:', err);
  }

  // Show/hide Login or Logout button
  if (isLoggedIn) {
    if (logoutBtn) logoutBtn.style.display = 'inline-block';
    if (loginBtn)  loginBtn.style.display  = 'none';
  } else {
    if (logoutBtn) logoutBtn.style.display = 'none';
    if (loginBtn)  loginBtn.style.display  = 'inline-block';
  }

  // Wire up login/logout buttons
  if (loginBtn) {
    loginBtn.addEventListener('click', () => {
      window.location.href = '/login';
    });
  }
  if (logoutBtn) {
    logoutBtn.addEventListener('click', () => {
      window.location.href = '/logout';
    });
  }

  /* ------------------------------------------------------------------
     2) If user not logged in, stop here so we don't load calendars
  ------------------------------------------------------------------ */
  if (!isLoggedIn) {
    return;
  }

  /* ------------------------------------------------------------------
     3) Helper Functions
  ------------------------------------------------------------------ */
  function showError(msg) {
    errorDiv.textContent = msg;
    errorDiv.style.display = 'block';
  }

  function hideError() {
    errorDiv.style.display = 'none';
  }

  async function fetchJSON(url, options = {}) {
    const res = await fetch(url, options);
    if (!res.ok) {
      throw new Error(`Fetch error (${res.status}): ${await res.text()}`);
    }
    return res.json();
  }

  async function createEvent({ calendarId, title, start, end, participants }) {
    return fetchJSON('/api/create_event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ calendarId, title, start, end, participants }),
    });
  }

  async function deleteEvent({ calendarId, id }) {
    return fetchJSON('/api/delete_event', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ calendarId, id }),
    });
  }

  /* ------------------------------------------------------------------
     4) Fetch Rooms
  ------------------------------------------------------------------ */
  let rooms = [];
  try {
    const data = await fetchJSON('/api/rooms');
    rooms = data.rooms; // e.g. [{id, summary, description}, ...]
    hideError();
  } catch (err) {
    console.error(err);
    showError('Failed to load rooms.');
    return;
  }

  if (!rooms || rooms.length === 0) {
    showError('No rooms found.');
    return;
  }

  /* ------------------------------------------------------------------
     5) Create Tabs for Each Room
  ------------------------------------------------------------------ */
  rooms.forEach((room, index) => {
    // Create the tab
    const tabId   = `tab-${room.id}`;
    const paneId  = `pane-${room.id}`;
    const li      = document.createElement('li');
    li.className  = 'nav-item';

    li.innerHTML = `
      <button 
        class="nav-link ${index === 0 ? 'active' : ''}"
        id="${tabId}"
        data-bs-toggle="tab"
        data-bs-target="#${paneId}"
        type="button"
        role="tab"
      >
        ${room.summary}
      </button>
    `;
    roomTabs.appendChild(li);

    // Create the tab pane
    const pane = document.createElement('div');
    pane.className = `tab-pane fade ${index === 0 ? 'show active' : ''}`;
    pane.id = paneId;
    pane.innerHTML = `
      <div 
        id="calendar-container-${room.id}" 
        style="height:100%; min-height:600px;"
      ></div>
    `;
    roomTabContent.appendChild(pane);

    // Initialize last known version for each room
    lastKnownVersions[room.id] = 0;

    // Lazy-init the calendar on tab click or immediately for the first tab
    if (index === 0) {
      initCalendar(room.id);
    } else {
      document.getElementById(tabId).addEventListener('click', () => {
        if (!calendars[room.id]) {
          initCalendar(room.id);
        }
      });
    }
  });

  /* ------------------------------------------------------------------
     6) FullCalendar Initialization
  ------------------------------------------------------------------ */
  function initCalendar(calendarId) {
    const calendarEl = document.getElementById(`calendar-container-${calendarId}`);
    const calendar = new FullCalendar.Calendar(calendarEl, {
      initialView: 'dayGridMonth',
      height: 'auto',
      headerToolbar: {
        left: 'prev,next today',
        center: 'title',
        right: 'dayGridMonth,timeGridWeek,timeGridDay',
      },
      events: async (info, successCallback, failureCallback) => {
        try {
          const data = await fetchJSON(`/api/room_data?calendarId=${encodeURIComponent(calendarId)}`);
          successCallback(data.events || []);
        } catch (err) {
          console.error(err);
          failureCallback(err);
        }
      },
      selectable: true,
      select: (selectionInfo) => {
        if (!isPopupVisible) {
          openEventModal({
            calendarId,
            start: selectionInfo.startStr,
            end: selectionInfo.endStr,
          });
        }
      },
      eventClick: (clickInfo) => {
        openEventPopup(clickInfo.event, calendarId, clickInfo.jsEvent);
      },
    });
    calendar.render();
    calendars[calendarId] = calendar;
  }

  /* ------------------------------------------------------------------
     7) Event Popup Logic
  ------------------------------------------------------------------ */
  function openEventPopup(event, calendarId, jsEvent) {
    isPopupVisible = true;

    eventPopup.style.display = 'block';
    eventPopup.style.left = '-9999px';
    eventPopup.style.top = '-9999px';

    const offset = 10;
    let popupLeft = jsEvent.pageX + offset;
    let popupTop  = jsEvent.pageY + offset;

    const rect = eventPopup.getBoundingClientRect();
    const popupWidth = rect.width;
    const popupHeight = rect.height;

    const vw = window.innerWidth;
    const vh = window.innerHeight;

    if (popupLeft + popupWidth > vw) {
      popupLeft = vw - popupWidth - offset;
    }
    if (popupTop + popupHeight > vh) {
      popupTop = vh - popupHeight - offset;
    }

    eventPopup.style.left = `${popupLeft}px`;
    eventPopup.style.top  = `${popupTop}px`;

    popupTitle.textContent = event.title || 'Untitled';

    const startTime = event.start ? new Date(event.start) : null;
    const endTime   = event.end   ? new Date(event.end)   : null;
    const timeOpts  = { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' };

    popupTimeStart.textContent = startTime
      ? startTime.toLocaleString(undefined, timeOpts)
      : 'N/A';
    popupTimeEnd.textContent = endTime
      ? endTime.toLocaleString(undefined, timeOpts)
      : 'N/A';

    popupOrganizer.textContent = event.extendedProps?.organizer || '';
    const attendees = event.extendedProps?.attendees || event.attendees || [];
    popupAttendees.textContent = Array.isArray(attendees) ? attendees.join(', ') : '';

    editEventBtn.onclick = () => {
      openEventModal({
        calendarId,
        eventId: event.id,
        title: event.title,
        start: event.start,
        end: event.end,
        attendees,
      });
      closeEventPopup();
    };

    deleteEventBtn.onclick = async () => {
      if (confirm('Are you sure you want to delete this event?')) {
        try {
          await deleteEvent({ calendarId, id: event.id });
          closeEventPopup();
          calendars[calendarId]?.refetchEvents();
        } catch (err) {
          console.error(err);
          showError('Failed to delete event.');
        }
      }
    };

    closePopupBtn.onclick = closeEventPopup;
  }

  function closeEventPopup() {
    eventPopup.style.display = 'none';
    isPopupVisible = false;
  }

  /* ------------------------------------------------------------------
     8) Modal Logic (Create/Edit)
  ------------------------------------------------------------------ */
  function openEventModal({ calendarId, eventId, title, start, end, attendees }) {
    calendarIdField.value = calendarId || '';
    eventIdField.value    = eventId    || '';
    eventTitleField.value = title      || '';

    if (start) {
      const dt = new Date(start);
      eventStartField.value = dt.toISOString().slice(0,16);
    } else {
      eventStartField.value = '';
    }

    if (end) {
      const dt = new Date(end);
      eventEndField.value = dt.toISOString().slice(0,16);
    } else {
      eventEndField.value = '';
    }

    if (attendees && attendees.length > 0) {
      eventGuestsField.value = attendees.join(', ');
    } else {
      eventGuestsField.value = '';
    }

    eventModal.show();
  }

  eventForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    const calendarId   = calendarIdField.value;
    const eventId      = eventIdField.value;
    const title        = eventTitleField.value;
    const guestsStr    = eventGuestsField.value;
    const participants = guestsStr.split(',').map(s => s.trim()).filter(Boolean);

    // *** Key Part: Convert local input to UTC ***
    // eventStartField.value and eventEndField.value are local date/time
    const localStart   = new Date(eventStartField.value); // local
    const localEnd     = new Date(eventEndField.value);   // local
    const startUTC     = localStart.toISOString();        // e.g. "2024-12-25T02:00:00.000Z"
    const endUTC       = localEnd.toISOString();

    if (!calendarId || !title || !startUTC || !endUTC) {
      showError('Missing required fields.');
      return;
    }

    try {
      // If updating an existing event (quick approach: delete + create)
      if (eventId) {
        await deleteEvent({ calendarId, id: eventId });
      }
      await createEvent({ calendarId, title, start: startUTC, end: endUTC, participants });

      eventModal.hide();
      hideError();

      calendars[calendarId]?.refetchEvents();
    } catch (err) {
      console.error(err);
      showError('Failed to save event.');
    }
  });

  /* ------------------------------------------------------------------
     9) Polling for Room Updates
  ------------------------------------------------------------------ */
  setInterval(checkRoomUpdates, 30000);

  async function checkRoomUpdates() {
    try {
      const data = await fetchJSON('/api/room_updates');
      data.updates.forEach(({ roomId, version }) => {
        const currentVer = lastKnownVersions[roomId] || 0;
        if (version > currentVer) {
          lastKnownVersions[roomId] = version;
          if (calendars[roomId]) {
            calendars[roomId].refetchEvents();
          }
        }
      });
    } catch (err) {
      console.error('Failed to check updates:', err);
    }
  }

  // Optionally run once
  checkRoomUpdates();
});
