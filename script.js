let calls = [];

function addCall() {
  const number = "+44 7700 900123";
  const time = new Date().toLocaleTimeString();

  calls.push(`Missed call from ${number} at ${time}`);
  renderCalls();
}

function renderCalls() {
  const list = document.getElementById("callList");
  const count = document.getElementById("callCount");

  list.innerHTML = "";
  calls.forEach(call => {
    const li = document.createElement("li");
    li.textContent = call;
    list.appendChild(li);
  });

  count.textContent = calls.length;
}

function clearCalls() {
  calls = [];
  renderCalls();
}

function saveDetails() {
  const setup = document.getElementById("setupOption").value;
  document.getElementById("setupDisplay").textContent = setup;
}

function saveMessage() {
  alert("Message saved!");
}

function scrollToSetup() {
  document.getElementById("setupSection").scrollIntoView({ behavior: "smooth" });
}