/* ------------------------------------------------------------------
   calendar.js
   - Sets up FullCalendar and handles event CRUD logic
   - Relies on globals from main.js:
       showToast, showError, showSpinner, hideSpinner, fetchJSON, etc.
       currentUserEmail, prefetchedUsers, rooms, allEventsMap, ...
------------------------------------------------------------------ */

function initCalendar() {
  const multiCalendarEl = document.getElementById('multiCalendar');

  const { 
    rooms, 
    allEventsMap, 
    currentUserEmail,
    fetchJSON,
    showToast,
    showError,
    showSpinner,
    hideSpinner,
    roomColors
  } = window;

  window.multiCalendar = new FullCalendar.Calendar(multiCalendarEl, {
    timeZone: 'local',
    height: 'auto',
    nowIndicator: true,
    slotMinTime: '08:00:00',
    slotMaxTime: '18:00:00',
    initialView: 'timeGridWeek',
    firstDay: 1,
    headerToolbar: {
      left: 'prev,next today',
      center: 'title',
      right: 'dayGridMonth,timeGridWeek,timeGridDay',
    },
    selectable: true,
    selectMirror: true,
    unselectAuto: false, // keep highlight until we manually unselect
    editable: true,
    eventResizableFromStart: true,

    selectAllow: (selectInfo) => {
      // Prevent creating events in the past
      if (selectInfo.start < new Date()) {
        return false;
      }
      return true;
    },

    select: (info) => {
      const firstRoomId = getFirstCheckedRoomId();
      if (!firstRoomId) return;

      const color = roomColors[firstRoomId] || '#0d6efd';
      setTimeout(() => {
        const highlights = document.querySelectorAll('.fc-highlight');
        highlights.forEach((el) => {
          el.style.backgroundColor = color;
        });
      }, 0);

      // Overlap check
      const dummyEvent = { 
        id: 'dummy', 
        source: { id: firstRoomId }
      };
      if (doesOverlap(dummyEvent, info.start, info.end, window.multiCalendar)) {
        showToast('Error', 'Time slot overlaps another event in that room.');
        window.multiCalendar.unselect();
        return;
      }

      openEventModal({
        calendarId: firstRoomId,
        start: info.start,
        end: info.end
      });
    },

    dateClick: (info) => {
      const start = info.date;
      const end   = new Date(start.getTime() + 30 * 60 * 1000);

      const firstRoomId = getFirstCheckedRoomId();
      if (!firstRoomId) return;

      // Block clicks in the past
      if (start < new Date()) {
        showToast('Error', 'Cannot create an event in the past.');
        return;
      }

      // Overlap check
      const dummyEvent = { 
        id: 'dummy', 
        source: { id: firstRoomId }
      };
      if (doesOverlap(dummyEvent, start, end, window.multiCalendar)) {
        showToast('Error', 'Time slot overlaps another event in that room.');
        return;
      }

      openEventModal({
        calendarId: firstRoomId,
        start,
        end
      });
    },

    eventClick: (clickInfo) => {
      const calendarId = clickInfo.event.source?.id || null;
      if (calendarId) {
        openViewEventModal(clickInfo.event, calendarId);
      }
    },

    eventDrop: (info) => {
      const event   = info.event;
      const newStart= event.start;
      const newEnd  = event.end || new Date(newStart.getTime() + 30*60*1000);

      if (doesOverlap(event, newStart, newEnd, window.multiCalendar)) {
        showToast('Error', "This move overlaps another event in the same room. Reverting.");
        info.revert();
        return;
      }

      const roomId = event.source?.id;
      if (!roomId) {
        info.revert();
        return;
      }

      showSpinner();
      setTimeout(async () => {
        try {
          await updateEvent({
            calendarId: roomId,
            eventId: event.id,
            title: event.title,
            start: newStart.toISOString(),
            end:   newEnd.toISOString(),
            participants: event.extendedProps.attendees || []
          });
          showToast("Updated", "Event was successfully moved.");
          await resyncSingleRoom(roomId);
          window.multiCalendar.getEventSourceById(roomId)?.refetch();
        } catch (err) {
          console.error("Failed to move event:", err);
          showError(`Failed to move event: ${err.message}`);
          info.revert();
        } finally {
          hideSpinner();
        }
      }, 0);
    },

    eventResize: (info) => {
      const event   = info.event;
      const newStart= event.start;
      const newEnd  = event.end;

      if (!newEnd) {
        info.revert();
        return;
      }

      if (doesOverlap(event, newStart, newEnd, window.multiCalendar)) {
        showToast('Error', "Resized event overlaps another event in the same room. Reverting.");
        info.revert();
        return;
      }

      const roomId = event.source?.id;
      if (!roomId) {
        info.revert();
        return;
      }

      showSpinner();
      setTimeout(async () => {
        try {
          await updateEvent({
            calendarId: roomId,
            eventId: event.id,
            title: event.title,
            start: newStart.toISOString(),
            end:   newEnd.toISOString(),
            participants: event.extendedProps.attendees || []
          });
          showToast("Updated", "Event was resized successfully.");
          await resyncSingleRoom(roomId);
          window.multiCalendar.getEventSourceById(roomId)?.refetch();
        } catch (err) {
          console.error("Failed to resize event:", err);
          showError(`Failed to resize event: ${err.message}`);
          info.revert();
        } finally {
          hideSpinner();
        }
      }, 0);
    },

    eventSources: []
  });

  window.multiCalendar.render();

  // If user closes the Create/Edit modal, unselect highlight
  const eventModalEl = document.getElementById('eventModal');
  if (eventModalEl) {
    eventModalEl.addEventListener('hide.bs.modal', () => {
      window.multiCalendar.unselect();
    });
  }

  /* ------------------------------------------------------------------
     Overlap Checking
  ------------------------------------------------------------------ */
  function doesOverlap(movingEvent, newStart, newEnd, calendar) {
    const allEvents = calendar.getEvents();
    const newStartMs = newStart.getTime();
    const newEndMs   = newEnd.getTime();

    for (const ev of allEvents) {
      if (ev.id === movingEvent.id) continue;
      const evStart = ev.start?.getTime();
      const evEnd   = (ev.end || ev.start)?.getTime();
      if (evStart < newEndMs && evEnd > newStartMs) {
        if (sameRoomSource(movingEvent, ev)) {
          return true;
        }
      }
    }
    return false;
  }
  function sameRoomSource(evA, evB) {
    const srcIdA = evA.source?.id || '';
    const srcIdB = evB.source?.id || '';
    return (srcIdA === srcIdB);
  }
  function getFirstCheckedRoomId() {
    const roomsCheckboxBar = document.getElementById('roomsCheckboxBar');
    if (!roomsCheckboxBar) return null;
    const checkboxes = roomsCheckboxBar.querySelectorAll('input[type="checkbox"]');
    const checked = Array.from(checkboxes).filter(ch => ch.checked);
    return checked.length > 0 ? checked[0].value : null;
  }

  /* ------------------------------------------------------------------
     View Event Modal (updated for new structure)
  ------------------------------------------------------------------ */
  window.openViewEventModal = function(event, calendarId) {
    // 1) References to new modal elements
    const viewEventModalEl     = document.getElementById('viewEventModal');
    const viewEventTitleEl     = document.getElementById('viewEventTitle');
    const viewEventDateTimeEl  = document.getElementById('viewEventDateTime');
    const viewEventRoomEl      = document.getElementById('viewEventRoom');
    const viewEventAttendeesEl = document.getElementById('viewEventAttendeesList');

    const viewEventEditBtn     = document.getElementById('viewEventEditBtn');
    const viewEventDeleteBtn   = document.getElementById('viewEventDeleteBtn');

    // The color circle
    const colorCircleEl        = viewEventModalEl.querySelector('.color-circle');

    if (!calendarId) return;

    // 2) Room & color
    const foundRoom = rooms.find(r => r.id === calendarId);
    const roomName  = foundRoom ? foundRoom.summary : "Unknown Room";
    const roomColor = roomColors[calendarId] || '#0d6efd';

    // 3) Populate Title
    viewEventTitleEl.textContent = event.title || 'Untitled';

    // 4) Populate Date/Time
    const startTime = event.start ? new Date(event.start) : null;
    const endTime   = event.end   ? new Date(event.end)   : null;
    if (startTime && endTime) {
      const formatOptions = {
        year: 'numeric', month: 'long', day: 'numeric',
        hour: '2-digit', minute: '2-digit'
      };
      const startStr = startTime.toLocaleString([], formatOptions);
      const endStr   = endTime.toLocaleString([], formatOptions);
      viewEventDateTimeEl.textContent = `${startStr} – ${endStr}`;
    } else {
      viewEventDateTimeEl.textContent = 'N/A';
    }

    // 5) Populate Room
    viewEventRoomEl.textContent = roomName;

    // 6) Update color circle
    if (colorCircleEl) {
      colorCircleEl.style.backgroundColor = roomColor;
    }

    // 7) Attendees
    const rawAttendees = event.extendedProps?.attendees || event.attendees?.map(a => a.email) || [];
    viewEventAttendeesEl.innerHTML = ''; // Clear old items

    rawAttendees.forEach(email => {
      const rowDiv = document.createElement('div');
      rowDiv.className = 'd-flex align-items-center gap-2 mb-2';

      const icon = document.createElement('i');
      icon.className = 'bi bi-envelope';

      const span = document.createElement('span');
      span.textContent = email;

      rowDiv.appendChild(icon);
      rowDiv.appendChild(span);
      viewEventAttendeesEl.appendChild(rowDiv);
    });

    // 8) Edit & Delete Permissions
    const isLinked     = (event.extendedProps?.is_linked === 'true');
    const creatorEmail = event.extendedProps?.creator_email;
    let canEditOrDelete = true;

    // If linked, disallow direct edit
    if (isLinked) {
      canEditOrDelete = false;
    } else {
      // If user is neither organizer nor attendee
      const allAttendees = rawAttendees;
      if (!allAttendees.includes(currentUserEmail) && creatorEmail !== currentUserEmail) {
        canEditOrDelete = false;
      }
    }

    viewEventEditBtn.style.display   = canEditOrDelete ? 'inline-block' : 'none';
    viewEventDeleteBtn.style.display = canEditOrDelete ? 'inline-block' : 'none';

    // Edit button => open the create/edit modal
    viewEventEditBtn.onclick = () => {
      if (!canEditOrDelete) return;
      openEventModal({
        calendarId,
        eventId: event.id,
        title: event.title,
        start: event.start,
        end: event.end,
        attendees: rawAttendees
      });

      const modalInstance = bootstrap.Modal.getInstance(viewEventModalEl);
      if (modalInstance) modalInstance.hide();
    };

    // Delete button
    viewEventDeleteBtn.onclick = async () => {
      if (!canEditOrDelete) return;
      const confirmDelete = confirm('Are you sure you want to delete this event?');
      if (!confirmDelete) return;

      try {
        await deleteEvent({ calendarId, id: event.id });
        allEventsMap[calendarId] = allEventsMap[calendarId].filter(ev => ev.id !== event.id);
        window.multiCalendar.getEventSourceById(calendarId)?.refetch();

        const modalInstance = bootstrap.Modal.getInstance(viewEventModalEl);
        if (modalInstance) modalInstance.hide();

        showToast("Deleted", "Event was successfully deleted.");
      } catch (err) {
        showError(`Failed to delete event: ${err.message}`);
      }
    };

    // Finally show the modal
    const bsModal = new bootstrap.Modal(viewEventModalEl);
    bsModal.show();
  };

  /* ------------------------------------------------------------------
     Create/Edit Modal
  ------------------------------------------------------------------ */
  function openEventModal({ calendarId, eventId, title, start, end, attendees }) {
    const {
      eventModal,
      calendarIdField,
      eventIdField,
      eventTitleField,
      eventStartField,
      eventEndField,
      eventGuestsContainer,
      eventGuestsInput,
      toLocalDateTimeInput
    } = window;

    // NEW: find the room name
    const foundRoom = rooms.find(r => r.id === calendarId);
    const roomName  = foundRoom ? foundRoom.summary : "Unknown Room";
    const eventRoomNameField = document.getElementById('eventRoomName');
    if (eventRoomNameField) {
      eventRoomNameField.value = roomName;
    }

    // Set the color of the modal header if desired
    const modalHeader = document.querySelector('#eventModal .modal-header');
    if (modalHeader) {
      const roomColor = roomColors[calendarId] || '#0d6efd';
      modalHeader.classList.add('text-white');
      modalHeader.style.backgroundColor = roomColor;
    }

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

    // Reset chips
    window.inviteChips = [];
    window.clearChipsUI();

    if (attendees && attendees.length > 0) {
      attendees.forEach((email) => {
        const userObj = window.prefetchedUsers.find(u => u.email === email);
        if (userObj) {
          window.addChip({
            label: `${userObj.name} <${userObj.email}>`,
            email: userObj.email
          });
        } else {
          window.addChip({ label: email, email });
        }
      });
      window.renderChipsUI();
    }

    eventModal.show();
  }

  window.openEventModal = openEventModal;

  // Save: create or update event
  eventForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const {
      calendarIdField,
      eventIdField,
      eventTitleField,
      eventStartField,
      eventEndField,
      inviteChips,
    } = window;

    const calendarId = calendarIdField.value;
    const eventId    = eventIdField.value;
    const title      = eventTitleField.value.trim();

    const localStart = new Date(eventStartField.value);
    const localEnd   = new Date(eventEndField.value);
    const startUTC   = localStart.toISOString();
    const endUTC     = localEnd.toISOString();

    if (!calendarId || !title) {
      showError('Missing required fields.');
      return;
    }

    const participants = inviteChips.map(ch => ch.email);

    if (!startUTC || !endUTC) {
      showError('Missing start or end time.');
      return;
    }
    if (localStart < new Date()) {
      showError('Cannot create or update an event in the past.');
      return;
    }
    if (localEnd <= localStart) {
      showError('End time must be after start time.');
      return;
    }

    showSpinner();
    try {
      if (eventId) {
        // Updating existing
        await updateEvent({ calendarId, eventId, title, start: startUTC, end: endUTC, participants });
        showToast("Updated", "Event was successfully updated.");
      } else {
        // Creating new
        await createEvent({ calendarId, title, start: startUTC, end: endUTC, participants });
        showToast("Created", "Event was successfully created.");
      }
      await resyncSingleRoom(calendarId);
      window.multiCalendar.getEventSourceById(calendarId)?.refetch();

      window.eventModal.hide();
      window.multiCalendar.unselect();
    } catch (err) {
      showError(`Failed to save event: ${err.message}`);
    } finally {
      hideSpinner();
    }
  });

  /* Event CRUD helpers */
  async function createEvent({ calendarId, title, start, end, participants }) {
    return fetchJSON('/api/create_event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ calendarId, title, start, end, participants }),
    });
  }
  async function updateEvent({ calendarId, eventId, title, start, end, participants }) {
    return fetchJSON('/api/update_event', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ calendarId, eventId, title, start, end, participants }),
    });
  }
  async function deleteEvent({ calendarId, id }) {
    return fetchJSON('/api/delete_event', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ calendarId, id }),
    });
  }

  /* Re-sync single room (used by polling in main.js) */
  window.resyncSingleRoom = async function(roomId) {
    try {
      const resp = await fetchJSON(`/api/room_data?calendarId=${encodeURIComponent(roomId)}`);
      window.allEventsMap[roomId] = resp.events || [];
    } catch (err) {
      showError(`Failed to re-sync room: ${roomId}. ${err.message}`);
    }
  };
}
