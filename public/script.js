document.addEventListener('DOMContentLoaded', async () => {
  /* ------------------------------------------------------------------
     1) DOM References
  ------------------------------------------------------------------ */
  const loginBtn        = document.getElementById('loginBtn');
  const logoutBtn       = document.getElementById('logoutBtn');
  const errorDiv        = document.getElementById('error');

  // Tabs
  const roomTabs        = document.getElementById('roomTabs');
  const roomTabContent  = document.getElementById('roomTabContent');

  // Popup Overlay & Popup
  const popupOverlay    = document.getElementById('popupOverlay');
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
  const eventModal      = new bootstrap.Modal(document.getElementById('eventModal'));
  const eventForm       = document.getElementById('eventForm');
  const calendarIdField = document.getElementById('calendarId');
  const eventIdField    = document.getElementById('eventId');
  const eventTitleField = document.getElementById('eventTitle');
  const eventStartField = document.getElementById('eventStart');
  const eventEndField   = document.getElementById('eventEnd');
  const eventGuestsField= document.getElementById('eventGuests');

  // Track state
  let isPopupVisible    = false;
  const calendars       = {};      // { calendarId: FullCalendar instance }
  const lastKnownVersions = {};    // { calendarId: number }

  /* ------------------------------------------------------------------
     2) Check if user is logged in
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

  // Login/Logout handlers
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

  // If not logged in, stop here
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
      const text = await res.text();
      throw new Error(`Fetch error (${res.status}): ${text}`);
    }
    return res.json();
  }

  async function createEvent({ calendarId, title, start, end, participants }) {
    // Calls /api/create_event with a POST
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

  // Convert a local JS Date => "YYYY-MM-DDTHH:mm" for <input type="datetime-local">
  function toLocalDateTimeInput(jsDate) {
    const year   = jsDate.getFullYear();
    const month  = String(jsDate.getMonth() + 1).padStart(2, '0');
    const day    = String(jsDate.getDate()).padStart(2, '0');
    const hour   = String(jsDate.getHours()).padStart(2, '0');
    const minute = String(jsDate.getMinutes()).padStart(2, '0');
    return `${year}-${month}-${day}T${hour}:${minute}`;
  }

  // Return true if dateObj is strictly before "now"
  function isPast(dateObj) {
    const now = new Date();
    return dateObj < now;
  }

  // If user clicks outside the popup => close popup
  popupOverlay.addEventListener('click', () => {
    if (isPopupVisible) {
      closeEventPopup();
    }
  });

  /* ------------------------------------------------------------------
     4) Fetch Rooms
  ------------------------------------------------------------------ */
  let rooms = [];
  try {
    const data = await fetchJSON('/api/rooms');
    rooms = data.rooms || [];
    hideError();
  } catch (err) {
    console.error(err);
    showError('Failed to load rooms.');
    return;
  }

  if (rooms.length === 0) {
    showError('No rooms found.');
    return;
  }

  /* ------------------------------------------------------------------
     5) Create Tabs for Each Room
  ------------------------------------------------------------------ */
  rooms.forEach((room, index) => {
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

    lastKnownVersions[room.id] = 0;

    // Initialize calendar for first room or upon tab click
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
      timeZone: 'local',
      height: 'auto',
      nowIndicator: true, // red line if you switch to timeGrid views
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
      // Single-day create, disallow if popup open or it's in the past
      dateClick: (info) => {
        if (isPopupVisible) return;
        if (isPast(info.date)) {
          return;
        }
        openEventModal({
          calendarId,
          start: info.date,
          end: info.date
        });
      },
      // Multi-day drag, disallow if start is past
      selectable: true,
      selectAllow: (selectInfo) => {
        if (isPast(selectInfo.start)) {
          return false;
        }
        return true;
      },
      select: (selectionInfo) => {
        if (isPopupVisible) return;
        openEventModal({
          calendarId,
          start: selectionInfo.start,
          end:   selectionInfo.end
        });
      },
      // View existing event
      eventClick: (clickInfo) => {
        if (isPopupVisible) return;
        openEventPopup(clickInfo.event, calendarId, clickInfo.jsEvent);
      },
    });
    calendar.render();
    calendars[calendarId] = calendar;
  }

  /* ------------------------------------------------------------------
     7) Popup Logic (View Existing Event)
  ------------------------------------------------------------------ */
  function openEventPopup(event, calendarId, jsEvent) {
    isPopupVisible = true;

    // Show overlay
    popupOverlay.style.display = 'block';
    // Show popup
    eventPopup.style.display = 'block';
    eventPopup.style.left = '-9999px';
    eventPopup.style.top  = '-9999px';

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
    const timeOpts  = { 
      year: 'numeric', month: 'long', day: 'numeric', 
      hour: '2-digit', minute: '2-digit'
    };

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
        attendees
      });
      closeEventPopup();
    };

    deleteEventBtn.onclick = async () => {
      if (confirm('Are you sure you want to delete this event?')) {
        try {
          await deleteEvent({ calendarId, id: event.id });

          // remove from FullCalendar
          const fcEvent = calendars[calendarId]?.getEventById(event.id);
          if (fcEvent) {
            fcEvent.remove();
          }

          closeEventPopup();
        } catch (err) {
          console.error(err);
          showError('Failed to delete event.');
        }
      }
    };

    closePopupBtn.onclick = closeEventPopup;
  }

  function closeEventPopup() {
    // Hide overlay
    popupOverlay.style.display = 'none';
    // Hide popup
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
      eventStartField.value = toLocalDateTimeInput(new Date(start));
    } else {
      eventStartField.value = '';
    }

    if (end) {
      eventEndField.value = toLocalDateTimeInput(new Date(end));
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
    hideError();

    const calendarId   = calendarIdField.value;
    const eventId      = eventIdField.value;
    const title        = eventTitleField.value.trim();
    const guestsStr    = eventGuestsField.value;
    const participants = guestsStr.split(',').map(s => s.trim()).filter(Boolean);

    const localStart = new Date(eventStartField.value);
    const localEnd   = new Date(eventEndField.value);
    const startUTC   = localStart.toISOString();
    const endUTC     = localEnd.toISOString();

    if (!calendarId || !title || !startUTC || !endUTC) {
      showError('Missing required fields.');
      return;
    }
    if (isPast(localStart)) {
      showError('Cannot create event in the past.');
      return;
    }

    try {
      // If editing => remove old
      if (eventId) {
        await deleteEvent({ calendarId, id: eventId });
      }

      // Create on server
      const result = await createEvent({
        calendarId,
        title,
        start: startUTC,
        end: endUTC,
        participants
      });

      // Hide modal
      eventModal.hide();

      // Add to FullCalendar immediately
      const localStartDate = new Date(startUTC);
      const localEndDate   = new Date(endUTC);

      calendars[calendarId]?.addEvent({
        id: result.event_id, // same as server => no duplicates
        title,
        start: localStartDate,
        end: localEndDate,
        attendees: participants,
        extendedProps: {
          organizer: 'You',
          attendees: participants
        }
      });

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

  checkRoomUpdates();
});
