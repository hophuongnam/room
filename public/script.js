document.addEventListener('DOMContentLoaded', async () => {
    const roomTabs = document.getElementById('roomTabs');
    const roomTabContent = document.getElementById('roomTabContent');
  
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
  
    function renderCalendar(containerId, calendarId, state) {
        const calendarEl = document.getElementById(containerId);
      
        // Initialize FullCalendar with saved state
        const calendar = new FullCalendar.Calendar(calendarEl, {
          initialView: state.initialView || 'dayGridMonth',
          initialDate: state.initialDate || new Date().toISOString().slice(0, 10),
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
          datesSet: function (info) {
            // Save the current view and date range to localStorage
            const roomState = {
              initialView: info.view.type,
              initialDate: info.startStr,
            };
            localStorage.setItem(`roomState-${calendarId}`, JSON.stringify(roomState));
          },
          selectable: true,
          select: function (info) {
            const eventModal = new bootstrap.Modal(document.getElementById('eventModal'));
            document.getElementById('eventStart').value = new Date(info.start).toISOString().slice(0, 16);
            document.getElementById('eventEnd').value = new Date(info.end).toISOString().slice(0, 16);
            document.getElementById('calendarId').value = calendarId;
            eventModal.show();
          },
          eventClick: function (info) {
            const popup = document.getElementById('eventPopup');
            const { clientX: x, clientY: y } = info.jsEvent;
          
            popup.style.left = `${x + 10}px`;
            popup.style.top = `${y + 10}px`;
            popup.style.display = 'block';
          
            // Populate event details
            document.getElementById('popupTitle').innerText = info.event.title || 'Untitled Event';
            document.getElementById('popupTime').innerText = `${info.event.start.toLocaleString()} - ${
              info.event.end ? info.event.end.toLocaleString() : 'No End Time'
            }`;
            document.getElementById('popupOrganizer').innerText =
              info.event.extendedProps.organizer || 'Unknown';
            document.getElementById('popupAttendees').innerText =
              info.event.extendedProps.attendees?.join(', ') || 'None';
          
            // Attach event handlers for buttons
            document.getElementById('editEvent').onclick = () => {
              const eventModal = new bootstrap.Modal(document.getElementById('eventModal'));
              document.getElementById('eventId').value = info.event.id;
              document.getElementById('calendarId').value = info.event.extendedProps.calendarId;
              document.getElementById('eventTitle').value = info.event.title;
              document.getElementById('eventStart').value = info.event.start.toISOString().slice(0, -1);
              document.getElementById('eventEnd').value = info.event.end ? info.event.end.toISOString().slice(0, -1) : '';
              eventModal.show();
              popup.style.display = 'none';
            };
          
            document.getElementById('deleteEvent').onclick = async () => {
              if (confirm('Are you sure you want to delete this event?')) {
                await deleteEvent(info.event, info.event.extendedProps.calendarId);
                popup.style.display = 'none';
              }
            };
          
            document.getElementById('closePopup').onclick = () => {
              popup.style.display = 'none';
            };
          },                   
        });
      
        // Render the calendar
        calendar.render();
    }      
      
    async function initializeTabs() {
        try {
          const { rooms } = await fetchRooms();
          const roomStates = {};
      
          rooms.forEach((room, index) => {
            const tabId = `tab-${room.id}`;
            const paneId = `pane-${room.id}`;
      
            // Create a new tab
            const tab = document.createElement('li');
            tab.className = 'nav-item';
            tab.innerHTML = `
              <button class="nav-link ${index === 0 ? 'active' : ''}" id="${tabId}" data-bs-toggle="tab" data-bs-target="#${paneId}" type="button" role="tab">
                ${room.summary}
              </button>`;
            roomTabs.appendChild(tab);
      
            // Create a new tab pane
            const pane = document.createElement('div');
            pane.className = `tab-pane fade ${index === 0 ? 'show active' : ''}`;
            pane.id = paneId;
            pane.innerHTML = `<div id="calendar-container-${room.id}" style="height:100%;"></div>`;
            roomTabContent.appendChild(pane);
      
            // Load saved state from localStorage
            const savedState = JSON.parse(localStorage.getItem(`roomState-${room.id}`)) || {};
            const state = (roomStates[room.id] = savedState);
      
            // Render the calendar for the first tab by default
            if (index === 0) {
              renderCalendar(`calendar-container-${room.id}`, room.id, state);
            }
      
            // Add event listener to switch tabs without resetting view
            document.getElementById(tabId).addEventListener('click', () => {
              const existingCalendarContainer = document.getElementById(`calendar-container-${room.id}`);
              if (!existingCalendarContainer.hasAttribute('data-rendered')) {
                renderCalendar(`calendar-container-${room.id}`, room.id, state);
                existingCalendarContainer.setAttribute('data-rendered', 'true');
              }
            });
          });
        } catch (error) {
          console.error('Error initializing tabs:', error);
        }
    }      

    initializeTabs();
  });
  