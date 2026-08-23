const tasks = [
  { id: "t-1", title: "Write release notes", status: "open" },
  { id: "t-2", title: "Review pull request", status: "done" },
  { id: "t-3", title: "Verify backup", status: "open" },
];

export function listTasks(status) {
  return tasks.filter((task) => (task.status = status));
}

export function countOpenTasks() {
  return listTasks("open").length;
}
