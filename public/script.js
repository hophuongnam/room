document.addEventListener('DOMContentLoaded', async () => {
    const roomTabs = document.getElementById('roomTabs');
    const roomTabContent = document.getElementById('roomTabContent');

    let isPopupVisible = false; // Track popup visibility

    async function fetchRooms() {
      const response = await fetch('/api/rooms');
      if (!response.ok) throw new Error('Failed to fetch rooms');
      return response.json();
    }

    async function fetchEvents(calendarId) {
      const response = await fetch(`/api/events?calendarId=${calendarId}`);
      if (!response.ok) throw new Error('Failed to fetch events');
      const data = await response.json();
      return data.events;
    }

    async function deleteEvent(event, calendarId) {
      const response = await fetch('/api/delete_event', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: event.id, calendarId })
      });
      if (!response.ok) throw new Error('Failed to delete event');
      window.location.reload();
    }

    function renderCalendar(containerId, calendarId) {
      const savedView = localStorage.getItem(`view_${calendarId}`);
      const savedDate = localStorage.getItem(`date_${calendarId}`);
      const calendarEl = document.getElementById(containerId);
      const calendar = new FullCalendar.Calendar(calendarEl, {
        initialView: savedView || 'dayGridMonth',
        initialDate: savedDate ? new Date(savedDate) : new Date(),
        headerToolbar: {
          left: 'prev,next today',
          center: 'title',
          right: 'dayGridMonth,timeGridWeek,timeGridDay',
        },
        events: async function (fetchInfo, successCallback, failureCallback) {
          try {
            const events = await fetchEvents(calendarId);
            successCallback(events);
          } catch (error) {
            failureCallback(error);
          }
        },
        eventClick: function (info) {
            isPopupVisible = true;
            const popup = document.getElementById('eventPopup');
            const { clientX: x, clientY: y } = info.jsEvent;
          
            // Set initial position
            popup.style.left = `${x + 10}px`;
            popup.style.top = `${y + 10}px`;
            popup.style.display = 'block';
          
            // Adjust position to keep popup within the viewport
            const popupRect = popup.getBoundingClientRect();
            const viewportWidth = window.innerWidth;
            const viewportHeight = window.innerHeight;
          
            let adjustedX = x + 10;
            let adjustedY = y + 10;
          
            if (popupRect.right > viewportWidth) {
              adjustedX = x - popupRect.width - 10; // Adjust to the left
            }
            if (popupRect.bottom > viewportHeight) {
              adjustedY = y - popupRect.height - 10; // Adjust upwards
            }
          
            popup.style.left = `${adjustedX}px`;
            popup.style.top = `${adjustedY}px`;
          
            // Populate popup content
            document.getElementById('popupTitle').innerText = info.event.title || 'Untitled Event';
            document.getElementById('popupTime').innerText = `${info.event.start.toLocaleString()} - ${
              info.event.end ? info.event.end.toLocaleString() : 'No End Time'
            }`;
          
            // Event handlers
            document.getElementById('editEvent').onclick = () => {
              const eventModal = new bootstrap.Modal(document.getElementById('eventModal'));
              document.getElementById('eventId').value = info.event.id;
              document.getElementById('calendarId').value = info.event.extendedProps.calendarId;
              document.getElementById('eventTitle').value = info.event.title;
              document.getElementById('eventStart').value = info.event.start.toISOString().slice(0, -1);
              document.getElementById('eventEnd').value = info.event.end ? info.event.end.toISOString().slice(0, -1) : '';
              eventModal.show();
              popup.style.display = 'none';
              isPopupVisible = false;
            };
          
            document.getElementById('deleteEvent').onclick = async () => {
              if (confirm('Are you sure you want to delete this event?')) {
                await deleteEvent(info.event, info.event.extendedProps.calendarId);
                popup.style.display = 'none';
                isPopupVisible = false;
              }
            };
          
            document.getElementById('closePopup').onclick = () => {
              popup.style.display = 'none';
              isPopupVisible = false;
            };
        },                            
        viewDidMount: function (view) {
          localStorage.setItem(`view_${calendarId}`, view.view.type);
          localStorage.setItem(`date_${calendarId}`, view.view.currentStart.toISOString());
        },
        selectable: true,
        select: function (info) {
          if (!isPopupVisible) {
            const eventModal = new bootstrap.Modal(document.getElementById('eventModal'));
            document.getElementById('eventStart').value = new Date(info.start).toISOString().slice(0, 16);
            document.getElementById('eventEnd').value = new Date(info.end).toISOString().slice(0, 16);
            document.getElementById('calendarId').value = calendarId;
            eventModal.show();
          }
        },
        unselectable: function () {
          return isPopupVisible;
        },
      });
      calendar.render();
      return calendar;
    }

    async function initializeTabs() {
      try {
        const { rooms } = await fetchRooms();
        const roomStates = {};
        rooms.forEach((room, index) => {
          const tabId = `tab-${room.id}`;
          const paneId = `pane-${room.id}`;

          const tab = document.createElement('li');
          tab.className = 'nav-item';
          tab.innerHTML = `
            <button class="nav-link ${index === 0 ? 'active' : ''}" id="${tabId}" data-bs-toggle="tab" data-bs-target="#${paneId}" type="button" role="tab">
              ${room.summary}
            </button>`;
          roomTabs.appendChild(tab);

          const pane = document.createElement('div');
          pane.className = `tab-pane fade ${index === 0 ? 'show active' : ''}`;
          pane.id = paneId;
          pane.innerHTML = `<div id="calendar-container-${room.id}" style="height:100%;"></div>`;
          roomTabContent.appendChild(pane);

          const state = roomStates[room.id] = {};
          if (index === 0) renderCalendar(`calendar-container-${room.id}`, room.id, state);
          document.getElementById(tabId).addEventListener('click', () => {
            renderCalendar(`calendar-container-${room.id}`, room.id, state);
          });
        });
      } catch (error) {
        console.error('Error initializing tabs:', error);
      }
    }

    initializeTabs();
  });
