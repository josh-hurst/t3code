# Working with threads

Use a new thread for a separate task. Choose **New worktree** when its code changes
need a separate branch and working directory. Threads in the same checkout share its
branch, so T3 Code refuses a branch switch there while one of them is working.

## Move the Threads window

Threads opens in a full-height sidebar beside the chat by default. To use a movable window
on desktop or in a wide browser, turn on **Settings → General → Sidebar → Floating sidebar**.
Drag its title to move it around the workspace, or click the pin to give the chat the full width.
Click the pin again to return Threads to the left. Drag the right edge to resize it.
Your device remembers its size and position.

When Threads is unpinned, drag its title outside the app and release to open it in a
separate window. Thread selections still open in the main app. Pin it to dock it again,
or close the separate window to return it to the workspace. Browsers need popup permission
for this; you can also use **Open sidebar in a separate window**.

To move it with the keyboard, focus the Threads title, press Space, use the arrow keys,
then press Space to drop it or Escape to cancel.

## Start a thread

On web and desktop, **New thread** opens the project picker when you have more than one
open project in the default or project-grouped sidebar. Archived projects don't count. The picker
lists pinned projects first, then the projects you started the most of your last 50 threads in.
Change how many threads count in **Settings → General → New thread project order**. Hover a project to pin it
or archive it; archiving hides it from pickers and keeps its threads, and the toast offers **Undo**. Later, unarchive it from the project's settings. **Shift-click** to start in
the current project, or use a project's own new-thread action. A new thread carries
your model and mode selections, unless the destination project has its own model default.
Its branch and workspace mode come from your configured defaults. To continue in
an existing worktree, use **New thread in this worktree** from the branch toolbar.
While the sidebar is filtered to one project, the sidebar's **New thread** button
starts the thread in that project instead of asking which project to use.

On mobile, **New thread** starts in the current thread's project, or else in the
project the thread list is filtered to, or else in the last project you opened
or chose on that device. If none is available, the project picker opens. Turn
off **Settings → General → Use last project** to choose a project every time.
When you pick a project that is on more than one machine, the thread starts on
a connected one if any is connected.

When you change a new thread's project, T3 Code stays in the current environment
if that project exists there. Otherwise it selects an environment that has it.

### Start without a project

A thread does not need a project. To start one without a project, click **or
start without a project** under a new thread's heading, pick **No project** from
the project menu in that heading or from **New thread in...** in the command
palette, or press `mod+alt+n`. On mobile, pick **No project** from the project
list. It starts on your current machine; before sending, pick another machine
from the machine menu to move it there. To move a draft into a project, pick the
project in the heading.

Each thread without a project works in its own folder under `~/.t3/scratch` (the
`scratch` folder of your T3 data directory), named after its date, the first words
of its first message, and a short id, like
`2026-09-25-convert-these-pngs-to-webp-a1b2c3d4`. Deleting a thread keeps its
folder, so the files the agent wrote stay until you delete them. Branch, worktree, and diff controls stay hidden because
these folders are not Git repositories. This is unavailable when the data
directory itself sits inside a Git checkout.

When the work grows into something real, pick **Turn into project** from the
thread's menu. The thread's folder becomes a project where it is, so nothing
moves and the agent keeps working in the same place. Other threads in that folder
move with it. Rename the project in its settings, and use **Initialize Git** to
get branch and diff controls.

### Start in the background

In a desktop browser or the desktop app, press `Cmd+Enter` on macOS or `Ctrl+Enter`
on Windows and Linux to start a new thread and immediately open another draft. The
next draft keeps the workspace mode and base branch you selected. With **New
worktree**, each background submission creates its own worktree.

To send the same prompt to several models on web or desktop, **Shift-click** models
in a new thread's model picker to add or remove them. A regular click returns to a
single model. Choose a base branch and send. Each selection starts a separate thread
and worktree while you stay in the new thread composer. This requires a Git project.

## Pin and reorder threads

Pin a thread from its menu to keep it above your active work.

On web and desktop, the rest of the sidebar files itself. Below your pins come
**Needs you**, **Recent**, **Working**, **Later**, and **History**, and each section
keeps its own order, so there is nothing to arrange by hand. Dragging still pins, unpins,
settles, un-settles, and wakes a thread; a thread you drop below the pins goes to Needs
you or Recent, wherever it belongs. An older thread can land under **more** in Recent.
The drag labels use these names, so the settled section reads **History**
and the snoozed one **Later**. To order active threads yourself, turn on
[the classic sidebar](#use-the-classic-sidebar). The mobile app files its list the same
way. **Clear** in Recent settles all its threads except the open one. One **Undo**
brings them back. For the hand-ordered list on mobile, turn on **Settings → General → Classic thread list**.

On web and desktop, unpinning, settling, snoozing, and archiving a thread each show
a notification with **Undo** for five seconds. Undo restores the thread's previous
state, including its pinned position, and reopens an archived thread you were
viewing. Discarding an unsent draft from the sidebar works the same way: Undo brings
back its text and attachments. `mod+z` triggers the most recent Undo, even from the composer; see
[Keybindings](./keybindings.md#commands-with-special-behavior).

On web and desktop, you can also drag files from your computer onto any thread row:
the thread opens and the files are attached in its composer, ready for
your next message. The same per-message file limits apply as when attaching
files directly; see [Attach files](./composer.md#attach-files).

On web and desktop, pinning or unpinning a thread keeps the sidebar at your current
scroll position instead of following the thread to its new place in the list.

A pinned thread is not settled automatically. Settling a thread removes its pin.

On web and desktop, drag a thread between sections to change its state. Drag a thread up into
the pinned section to pin it at the spot you drop it; drag a pinned thread down into the active
list to unpin it. Dragging a thread onto the **Settled** header settles it, and dragging a settled
thread into the active list un-settles it. A snoozed thread can be dragged out of the snoozed
shelf, which wakes it, but threads cannot be dragged into the shelf because snoozing needs a wake
time. Dragging a pinned thread out of the pinned section does not ask for unpin confirmation.
Pinned and active boundary labels appear only while dragging, without moving the rows. The
other rows slide aside to show where the thread will land. When you cross into another section,
the dragged thread shows the action the drop performs, with its icon: **Pin**, **Unpin**,
**Settle**, **Un-settle**, or **Wake**. Its status and hover actions hide during the drag. A pinned
thread keeps its pin only while it stays in the pinned section; once it leaves, the badge takes
over. Reordering within the same section shows no badge. When there are no pins, drag to the top
edge to pin a thread. Section labels stay readable for the whole drag, and the section the
thread is over takes the accent color. Section labels also
identify empty sections and a collapsed settled shelf.

Drag within the pinned section to change its order. Other rows slide aside to show the
spot where the thread will land, and the drop keeps the position you choose. The active
section works the same way in the classic sidebar. On
mobile, open a pinned thread's menu and choose **Arrange threads**; with **Classic thread list**
on and its Working section off, every active thread's menu has it too. Drag a handle within or between
**Pinned** and **Active** to reorder, pin, or unpin. Drop onto the **Settled** divider to
settle a thread. The dragged card shows the action before you release it. Expand **Snoozed**
or **Settled** to drag a parked thread back into either live section. Each drop saves; close the sheet to return to the thread list.
**Move up** and **Move down** are also available in the thread menu. The server
saves the order, so it survives a refresh and appears on your other connected devices.

On web and desktop, the list also animates section changes made with thread actions such as
**Pin**, **Settle**, and **Snooze**. These transitions respect your system's reduced-motion
preference. While dragging, rows follow the insertion gap without replaying a second transition
after the drop.

In the classic sidebar and on mobile, new threads appear above the active threads you have arranged. Settling clears a thread's active
position, so using **Un-settle** returns it to the top. Pinning and snoozing preserve its active
position until you move it again. Thread activity does not change the order. The settled shelf
continues to use settlement time.

If dragging is unavailable for one environment, update the T3 Code server running in that
environment. Pinned and active reordering require server support. Threads from older servers keep
their default order until the server is updated.

To generate a fresh title from the conversation, open a thread's menu and choose
**Regenerate title**. The action is unavailable while title generation is in progress
or when the connected environment needs a server update.

To change how titles are written, add **Thread title instructions** in **Settings → Threads →
Text generation**, under Advanced, such as a length limit or an identifier to put first. They apply to new and
regenerated titles. Select a project to give it its own instructions.

Agents connected through T3 Code can use the same server-owned metadata workflow to
rename a thread, regenerate its title, or link and unlink a pull request. These changes
appear on web, desktop, and mobile without requiring the originating browser to remain
open.

### Threads that are working

Threads that are working or waiting on work they will resume from sit in the **Working**
section. That includes subagents, watched pull requests with checks still running, Claude
monitors, and background commands or other monitors the agent says it is waiting on. A dev
server or other process an agent leaves running does not keep a thread there. A thread moves
to Needs you when it finishes, fails, or needs an approval or answer. Working lists the thread
you last sent work to first. Pinned threads stay in the pinned section.

In the classic sidebar the section starts collapsed, and **Settings → General → Working
section** turns it off. On iOS and Android, the same switch appears under **Settings → General**
once **Classic thread list** is on. While it is on there, the active list is ordered by when each thread
last came back to you, so you cannot drag or move threads within it. Each device keeps its
own choice.

### Threads that need you

**Needs you** gathers threads waiting on an approval, an answer, or a
guest, with a plan ready, with a question you have not read, or whose latest run failed.
Opening a failed thread keeps **Failed** visible. Starting another run shows its new status.
A finished run stays in Recent, marked **Done** until you leave the thread
or send it a message. A row's line is the outcome; it leads with **Question** only when a
question you read is still unanswered. The thread that has waited longest comes first. Pinned threads stay pinned and working threads stay in Working.

Answering a request or settling the thread takes it out of Needs you. A question an agent
writes at the end of a reply holds the thread there until you have read that reply: once you
leave the thread without answering, it moves to Recent and keeps its **Question** label. A later
background report that only repeats the question does not bring it back, and a new question
does. To put it back yourself, mark the thread unread. The
thread you have open stays where it was until you leave it, and moves once you send it a
message. A reply that arrives while the thread is on screen counts as read only when you leave.

**Next** on the Needs you header, or `thread.nextNeedsYou` (`mod+shift+u`), opens the next
thread that needs you, starting again from the top after the last one. Pinned threads that
need you come after the section's own, then **Done** threads in Recent. It is also in the
command palette.

In the classic sidebar, **Settings → General → Needs you section** chooses where the
section goes: **Above all projects**, **In each project** folder, or off. **Finished
threads in Needs you** decides whether a finished run you haven't opened counts. With the
Working section off, threads below Needs you keep your order and can still be dragged; the
Needs you rows hold their place.

<a id="later-and-the-trail"></a>

### Later and Recent

**Later** holds threads you [put off](#snooze-until-later) and says what each waits for: a
wake time, a re-check and its reason, **Set aside**, or **Standing check**. Threads with a
time come first, soonest first.

**Recent** holds every other unsettled thread, ordered by when you last sent it a message or
its latest run finished, most recent first. Opening a thread never reorders it. It shows the
eight most recent threads; a finished run you haven't opened is marked **Done**. Click the
row below them, such as **5 more today, 3 earlier**, to see the rest grouped by day.
While those rows or History are open, use **By day** in the Recent header to switch
between day and project groups. The first eight keep their order. Hover a time in
Recent to see exactly when you last wrote to the thread or its run finished, or in Needs you to see how long it has waited.

**Clear** in the Recent header, or `thread.clearTrail` (`mod+alt+s`), moves every thread
in Recent except the open one to History, including those under **more**. One **Undo**
brings them all back. In the command palette, choose **Clear recent threads**.

### Focus on one project

`sidebar.focusProject` (`mod+alt+p`) limits the sidebar to the open thread's project, the
same as picking that project in the sidebar's project filter. Press it again to return to
all projects. While the sidebar is limited this way, a row under the search field names the
project, with an **×** to show all projects again and, when threads in other projects need
you, a count such as **3 elsewhere**. Going to the next thread that needs you leaves
the project when nothing in it is waiting.

### Changes not out yet

A **Changes** button sits in the sidebar footer beside Pull requests, Issues, and Usage. Click it
to pick a recently active project (showing any uncommitted files or unpushed commits from Git) and
open its [Changes](#history-every-topic) view, or jump straight there when a single project is in
scope. Use the filter icon in the top right of the menu to hide or restore projects from that list.
Thread rows carry no publish, commit or check label: an agent that cannot go on until you do
something raises it as a question, which puts the thread in Needs you.

### Hide projects

On web and desktop, hover a project in the sidebar's project filter and click its eye button to
hide its threads from the sidebar, or choose **Hide** from a thread's menu or a boring-sidebar
folder's menu. Hidden projects are crossed out in the filter, and **All projects** shows how many
are hidden; click the eye again to show one. Picking a hidden project in the filter still shows
it, and opening one of its threads from a link, history, or the command palette shows the project
again. Each device keeps its own hidden projects.

### Group threads by project (beta)

Project folders belong to [the classic sidebar](#use-the-classic-sidebar); otherwise, use
**By day** in [Recent](#later-and-recent). With the classic sidebar on, turn
on **Settings → Labs → Boring sidebar (group by project)** on web and desktop to put active
threads in a folder for each project. Pinned projects come first. A project with no active
threads has no folder unless it is pinned or you pick it in the project filter. An archived
project's folder comes last and shows only while it has active threads. Click a folder to open or
close it. A closed folder shows how many threads it holds, and a dot when one of them
needs you. Use the pen button on a folder, or right-click it, to start a thread in that project.
Pinned threads stay above the folders, and Snoozed and Settled stay below them. Drag a thread
within its folder to reorder it, or drag a folder to reorder the folders, which sets
**Settings → General → Project order** to **Manual**. Drag a folder onto the chat box to add a link to the project's
folder, or drag a thread onto it to mention the thread. Threads cannot be dragged into another
folder, or pinned and settled by dragging, in this mode. Each device keeps its own choice.

On mobile, turn on **Classic thread list** in **Settings → General**, then **Settings → Labs →
Group by project**. Folders follow the project filter's
order, and a project with no active threads has no folder. Tap a folder to open or close it; a
closed folder shows how many threads it holds. Move up and Move down are off in this mode;
**Arrange threads…** in a thread's menu still reorders them.

### Choose what shows under a thread's title

Turn on **Settings → Threads → Text generation → Summarize latest reply** to give each thread a
one-line summary of what its latest finished run did, such as "Fixed flaky login test; 2 retries
removed". It shows under the thread's title on web, desktop, and mobile. Each row names its
project above the title (left out when the sidebar shows one project or the rows are grouped by
project). On Recent, Later, and History rows the summary follows what is still to do, such as
**Question**, **Check**, **Commit**, **Publish**, or **Follow up**; hover a row for the full summary and each
item. In Needs you, the summary follows why the thread is there, such as **Approval** or
**Question**: an approval shows the command or change it asks to make, and a thread with an open
question shows that question instead. The environment writes the
summary once per finished run with the **Reply summary model** chosen there, so each run costs one
short generation on that provider. A thread with no summary yet looks as before, and the
mobile **Classic thread list** does not show summaries.

While a thread works, its subtitle shows the plan step in progress. If the agent has no
current step, the subtitle shows its latest progress update or the request it is working on.
Threads with running subagents show a live status line per subagent and for the thread, refreshed
about once a minute using the reply-summary model. You can follow the work from the sidebar even
with reply summaries turned off.

For other threads without a summary on web and desktop, **Settings → General → Thread row
details** lets you choose **Branch**, **Latest message**, or **Both**. In
[the classic sidebar](#use-the-classic-sidebar), choosing the latest message shows its
reply summary when one is available. The setting also applies to two-line folder rows in the
boring sidebar. A thread started in your project's own
checkout without picking a branch has no branch to show.

## Settle finished work

Settling is optional on web and desktop. A thread you leave alone moves down
[Recent](#later-and-recent) and settles itself. Settled threads are listed under
**History**, grouped by the day they were settled. History starts collapsed and loads
older threads as you ask for more.

Choose **Settle thread** from its menu to move finished work out of the active list
without deleting the conversation. **Un-settle thread** restores it to active work
and prevents automatic settlement until new activity resumes the usual rules.
Manually settling an idle thread dismisses unanswered async questions without
sending an answer or restarting the agent. Settling also closes the thread's
terminals that wait at an idle prompt, and keeps their output. A terminal that
runs a command, such as a dev server, stays open unless its action has **Stop this action
when the thread settles** enabled in Settings > Projects > Actions. You can also set
`"stopOnSettle": true` on a `t3.json` action and import it there. Start the command through
that action so T3 can stop its terminal and child processes. Commands started through an
agent's own shell tools are managed by the provider.

To reclaim disk space from settled work, turn on **Run in the thread's worktree when the
thread settles** for one of the project's actions, or set `"runOnSettle": true` on a
`t3.json` script, for example `cargo clean`. It runs each time a thread in its own
worktree settles, manually or automatically, even if a terminal there still runs a
command such as a dev server. Threads in the project's main checkout skip it. Its terminal
closes when the command succeeds and stays open when it fails.

On web and desktop, press a thread's **Settle** button and drag up or down to
settle every thread in that section between it and the one you release on.
The **Un-settle** and **Wake** buttons work the same way in their sections.
Press `Escape` while dragging to cancel.

By default, environments settle inactive threads after 36 hours and settle
threads whose pull request merged. The setting counts in days and accepts half days,
so 36 hours is `1.5`. An environment that already has a value keeps it. A closed pull request can also settle an idle
thread. An empty thread's inactivity counts from when it was created.
Work in progress, pending questions or approvals, background work the agent
is waiting on, a snooze, and a pin prevent automatic settlement. An open pull request does not prevent inactivity
settlement unless you turn on **Keep threads with a PR** in **Settings → Threads**,
but an old closed or merged pull request does not settle work you
resumed after it closed. Only your own messages count as resuming. A turn that
finished background work or a pull request watch starts on its own does not.

A thread you are unlikely to write in again settles sooner than that setting. Once you have
read its latest reply, T3 Code estimates the chance you come back to it from how long it has
been quiet, how long it ran and how many messages you sent it, and what you have done in its
project since: messages in the project's other threads and a publish. Work in other projects
does not count, so a project you leave for another keeps its threads longer. A short thread
you left for other work in the project scores low within the hour; a long one you wrote in
often stays in Recent for much longer.

Nothing settles this way in its first hour and a half. At an hour and a half quiet, a thread whose chance is low settles if you have
worked in its project since and it is not a long one. One that misses that settles once its
chance is close to none, and any thread you have read settles after a day quiet, since you
almost never write in one again within the next day. A thread about to settle stays in its place in Recent; write in it to restart the wait, or
click its **Settling soon** label (on mobile, open the row's menu) and choose **Dismiss** to put
it off for three hours. Each dismiss before the thread's next activity doubles the wait. The
classic sidebar settles threads by the same rule.

A thread with a pull request keeps the full wait. Something its
summary lists for you to check, commit, or publish does not hold it, but a question you have
not read keeps it from settling on its own, and a thread stays at least an hour and a half
after you read one.

Nothing settles early while you are away. After two hours without a message from you in
any thread, early settling pauses, and it resumes an hour and a half after you next write. A
thread you looked at in the last hour and a half also waits, counted from when you left it.
Looking means at least 15 seconds with the window in front of you (on mobile, with the app
open), so a glance or a misclick does not hold a thread.

When threads settle on their own while T3 Code is in the background or another window has
focus, Recent ends with one line, such as **Settled 3 while you were away**. Click it to open
History, or choose **Undo** to bring those threads back and keep them from settling again until
they have new activity. Threads you settle yourself are never counted. The web and desktop apps
remember when you last looked across a restart; the mobile app counts only while it stays open
in the background.

A thread within an hour of settling shows **Settling soon** in the thread list, then counts
down in its last half hour, such as **Settling in 12 min**. The open thread shows the time left with **Keep open**, which turns auto-settle off for that
thread. On web and desktop, a thread's hover card and its details panel show the time left
at any point, and the details panel has the switch to turn it back on. In History, a thread
that settled on its own says **Auto settled**; **Un-settle thread** brings back one that went
too early.

To keep one thread out of the settled shelf no matter how long it sits idle, open its menu,
choose **Auto-settle behavior**, and pick **Never**. The current option is checked. Pick
**Follow settings** to return to the rules in **Settings → Threads**. While those rules are off,
a thread on **Follow settings** does not settle automatically either. Manual settle, snooze, and
archive still work while it is set to **Never**.

Change these rules in **Settings → Threads**.
They continue to run when your apps are closed. On web and desktop, choose an environment at the
top to change only its rules, or **All environments** to update connected environments together.
Mixed values show where the selected environments disagree. Mobile applies these
rules to connected environments that support shared settings. Offline environments
and older servers keep their previous values. Changing a rule does not reopen
already settled threads.

### Nest threads under a parent

Nest a thread under another so settling the parent settles it too. On web and desktop, drag
a thread onto another and nudge it to the right until the row shows **Nest**, then release.
To start a new thread already nested, choose **New child thread** from a thread's menu; it
nests once you send its first message. **Remove from parent** takes a thread back out.

Nesting changes nothing else. A nested thread still files itself by its own status: under its
parent while both sit in the same section, and on its own, naming its parent, when it needs
you or lands somewhere else. A nested thread that is still working, waiting on a question,
or holding a queued message stays put when its parent settles. Undoing the parent's settle
brings back the threads it settled with it.

### History: every topic

When [thread summaries](#choose-what-shows-under-a-threads-title) are on, each finished
reply is filed under a topic of its thread. A topic is a whole job: a thread that works on
one thing stays one topic however long it runs, and gets a second only when you turn to
unrelated work. **All** beside the sidebar's History label, or
`history.open` (`mod+shift+y`), opens the History page: every topic from every thread,
newest first by when it was last worked on, under day labels. Search matches topic titles
and outcomes; the chips limit it to one project. Click a topic to open its thread where the
topic started; **Latest result** opens it at the topic's last reply. Threads from before
topics were kept are only in the sidebar's History list until you add them: **Add older
threads…** at the foot of the page picks a project and a range, shows how many model calls
it will make, and runs only when you press **Start**, one call at a time, on the summary
model. It leaves those threads' summaries, open items and order alone, and you can cancel
it; starting it again picks up where it stopped. Long threads only is the cheaper choice.

**Unpublished** lists the topics whose work waits on a publish, including those on settled
threads.
An item clears when a later reply says it is done or when you press **Done** on it.
After you publish, choose a project and press **Mark published**, or run
**Mark this project published** from the command palette, to clear what waits on a publish
and start the re-checks that wait for one. **Undo** puts the items back, except on threads
whose summary changed since; re-checks it started stay started. An agent you tell "I've
published" marks it for you. History and Mark published need a server that keeps topics.

**Changes**, with a project chosen, shows what that project's main checkout holds that is not
out yet: uncommitted files by topic, then a changelog of your commits since the last publish
and for each publish before it. A changelog groups commits that belong to one piece of work
into one item that says what changed; click an item for its commits, each with a few words
on what it did (hover for its full subject), and **Not pushed** marks work on no remote.
Every publish is marked in green, and other contributors' commits are counted under the
publish they landed in. A project never marked published gets one changelog per week. Changelogs
are written by the summary model, one call per publish, when you open the view; with
**Summarize latest reply** off, the commits are listed as they are.
Threads working in their own worktrees are left out. File and commit counts come from Git.
The topic a file sits under is the last thread that edited it or ran a command naming it; a
thread that only talked, read or queried is never credited, and files no thread wrote that way
sit under **No thread changed these**. It can still be wrong when several threads work in one
checkout at once. The sidebar footer's [Changes](#changes-not-out-yet) button opens here.

On mobile, **All** beside the thread list's History label opens the same History screen, with
a project filter, Unpublished, search, **Mark published** (it asks first) and **Done**. Tap a
topic to open its thread where the topic started. In a thread with two or more topics, tap
the thread's title on iPhone and iPad to list them, or use **Contents** in the thread settings
sheet; tap one to scroll to where it started.
Mobile shows topics but does not rename or merge them.

## Link a pull request

The server finds the PR for each unsettled thread's saved branch, even when your
apps are closed. Settled threads keep their saved links. Update the server if
automatic branch links do not appear.

On web and desktop, right-click a pull request link in a thread and choose
**Link to thread** to select a different PR. Use **Unlink from thread** on the
same link to return to the branch PR, if one exists.
The linked pull request participates in automatic settlement.

## Find and reference work

On web and desktop, open the command palette with `Cmd/Ctrl+K` to search threads
across connected environments by title, branch, pull request, or project, and by
what a thread did when [thread summaries](#choose-what-shows-under-a-threads-title) are on.
Threads you open often or recently rank higher, and for three weeks the thread
you last picked for a query ranks higher when you type that query again.
Threads whose messages contain all your words appear below, under **In
messages**, and open at the matching message. Topics whose title and outcome contain your
words are listed there too, marked **Topic:**, and open where the topic started. Message search needs at least
one word of three or more letters, or two for Chinese, Japanese, and Korean.
On mobile, the thread list search also lists message matches and opens them at
the matching message; on an iPad with a keyboard, `Cmd+K` opens the same
palette.

A thread with two or more [topics](#history-every-topic) lists them under **Contents** in its
thread details, in the order they started, each with its outcome, led by **Question** or
**Publish** when the topic leaves one. Click
a topic to jump to where it started, or **Latest result** to jump to its last reply. The jump
rail beside the conversation draws a longer tick where each topic begins, and its preview
names the topic. To fix the grouping by hand, use a topic's **⋯** menu to **Rename** it or
**Merge into** another topic, or a message's **Topic** button to move that message and its
reply to another topic or to a **New topic…**; the **Topic** button also appears in a thread
that is still one topic. Each change offers **Undo** until the thread's topics change again.
**Split this thread into topics** in the command palette regroups the whole thread with three
short model calls. Topics you renamed, merged or moved keep your changes when the thread is
regrouped.

Use **Settings → Keybindings** to find or customize shortcuts for searching files
and copying a thread reference. A copied reference uses the thread's pull request
link when available, otherwise a link to the thread, which opens it from anywhere
you paste it and pastes into a composer as a thread chip (see
[sharing a thread](./prompt-links.md#share-a-thread)). To copy the thread even
when it has a PR, choose **Copy → Thread** from its context menu, or **Copy
thread** from its long-press menu on mobile.
**Thread ID** copies the bare ID for scripts and the `t3` CLI. See
[keybindings](./keybindings.md) for custom configuration.

## Inspect agent work

**Limited** means the provider stopped on a usage or rate limit. The conversation
keeps the provider's explanation. Retry after the limit resets, or switch to
another provider instance.
Press **Resume** in an empty composer to continue a limited or interrupted turn
manually when the provider supports native continuation, or send a message to continue.
Do this when the provider reports no reset time, because nothing continues the turn on its own.
Queued messages stay saved while the limit blocks the thread. They run after
the continuation finishes. If the queue was held by a restart, resume it then.

When the provider reports a reset time, choose **Resume at reset** to schedule a
continuation. You can cancel it from the thread. Enable **Resume after
usage limits** in **Settings → Threads** to schedule limit stops by default.
The environment must be running when the reset arrives; it resumes overdue
continuations after a restart. Stopping the thread, sending a new message,
archiving, or settling it prevents a pending continuation from starting.

Choose **Snooze until reset** to hide the thread until its allowance returns.
Snooze and auto-resume are independent: snooze alone wakes the thread without
sending a message; enabling both wakes and continues it. **Wake now** cancels
the snooze. Enable **Snooze until limits reset** in thread behavior settings to
snooze limit stops by default. Providers without a reset time offer manual
retry and the normal snooze choices.

On web and desktop, use **Agents** to follow work delegated to subagents. Click
a subagent there or on its conversation card to open it in the right panel,
beside the thread you are in. See
[Open a thread beside the one you are in](#open-a-thread-beside-the-one-you-are-in).
On mobile, open a subagent from its conversation card or **Agents**. On iOS
layouts with an inspector, its thread opens beside the parent. Maximize it to
fill the screen; close the full-screen view to return to the parent and inspector.
Stop on a thread also stops the subagents it delegated to.
Before archiving the parent, wait for its delegated tasks to finish or cancel them.

Subagent threads started by the agent can't take messages; message the parent
thread instead. When such a subagent needs an approval or an answer, the parent
thread asks for it.

Expand a tool call in the conversation to see its full command and output.
Summaries shorten shell wrappers and can still describe the latest call after it
finishes; the call's own result shows its status.

On web and desktop, the thread details card lists the local servers that the
thread's terminals or its Claude agent started, with their ports. Not every one
serves a web page. A server the agent started stays listed after the agent's
turn ends.
Select a server to open it in the browser panel. **Stop** ends the server's job
and keeps the agent, the terminal, and T3 Code running. Stop needs terminal
access to the environment and is not available on Windows.

To choose what the thread details card shows, right-click the card or open
**Settings → Appearance → Thread details**. Hidden rows keep their keyboard
shortcuts, such as Open in editor and project scripts. **Reset to default** brings
back the standard rows.

## Open a thread beside the one you are in

On web and desktop, a subagent, a side chat, and a
[thread on a linked machine](remote-access.md#read-a-linked-machines-threads)
all open the same way. Click one to open it as a tab in the right panel, so the
thread you are in stays in view. Hold ⌘ (Ctrl on Windows and Linux) while you
click, or middle-click, to open it in the main view instead. With the keyboard,
Enter and ⌘/Ctrl + Enter do the same. Right-click for **Open in side panel** and
**Open in main view**.

To make the main view the place a plain click opens them, set **Settings → Chat →
Open subagents and side chats in** to **Main view**. The modifier then opens
the side panel.

From a tab, **Open in main view** at the top of the tab, or in the tab's
right-click menu, moves it to the main view. The bottom of the view depends on
the thread: a side chat or a subagent you delegated has a composer, a subagent
the agent started is read-only, and a thread on a linked machine is read-only
with **Connect to interact**.

Other thread links open in the main view as before.

On mobile these threads open in the inspector on layouts that have one, where
Maximize fills the screen, and full screen everywhere else.

## Side chats

A side chat lets you ask a question about a thread without adding to it. It starts
with what the thread knows, and the thread keeps working while you ask.

On web and desktop, start a message with `/side` or `/btw`, then your question.
You can also choose **Side chat** from the **+** menu in the right panel. The side
chat opens as a tab there, with its own composer. Side chats do not show in the
sidebar. Find one again under **Side chats** in thread details, where it opens
[like a subagent does](#open-a-thread-beside-the-one-you-are-in).

A side chat works in the same folder as the thread and starts with the permissions,
model, and reasoning level shown in the thread's composer, including for its first
reply. Change them for an individual side chat in its composer. Later changes to the
parent do not change existing side chats.

To use what you learned, choose **Add to chat** at the top of the side chat, or type
`@` and a word from its title in the thread's composer. The thread's message gets a
link to the side chat, and the agent reads as much of it as it needs. This works
while the thread is busy, once you have sent a message in the side chat. An agent on
an external OpenCode server cannot read the link, so put the details in your message
instead.

Closing a side chat you never sent a message in deletes it. To delete one you used,
choose **Delete** at the top of the side chat. Deleting a thread also deletes its
side chats. Archiving a thread also archives its side chats and stops their work, and
unarchiving the thread brings them back.

On mobile, a thread lists its side chats above the composer. Tap one to open it and
answer its questions.

## Pop a thread out

To keep a thread in view while you work elsewhere, right-click it in the sidebar or open
the thread menu in its header, then choose **Open in new window**. The command palette
has **Open thread in new window** too. The thread opens in a floating glass window with
its own composer, so you can keep chatting with it. Choosing it again focuses the window
that is already open.

On desktop, the window stays on the Space where it opened; move it to another Space as you
would any window. On macOS, tiling window managers such as yabai float it rather than tile
it when it opens, and you can still tile it with your usual float toggle.

A pop-out can show a different thread: click the thread name at the top to open the thread
list, with the same sections as the sidebar, and choose another thread or start a new one.
Links to other threads and the command palette also stay in the pop-out. Right-click the
header for the thread's actions. Settings and other pages
open in the main window. To send the thread back, choose **Open in main window** from its menu,
or close the window. Browser previews stay in the main window. In a browser, allow pop-ups for
the site.

## Snooze until later

Snoozed threads are listed under **Later**, soonest wake time first; the classic sidebar
and the mobile app's classic thread list call the section **Snoozed**.

To change the choices in the snooze menu, open **Settings → Threads → Snooze options**.
Each option is a duration, such as 3 hours, or a time on a day, such as 9:00 PM
tomorrow. A weekday means the next one after today. Menus list the options soonest
first and hide a today option after its time passes. Saved with **All environments**
selected, the options apply to every connected environment, and the mobile app uses them too.

Choose **Snooze → Custom…** from a thread's menu to pick a date and time in your
local time zone, or a duration in minutes, hours, or days. Durations start when
you confirm; one day means 24 hours. On web and desktop, you can also snooze
several selected threads together. Choose **Wake thread** to bring a thread back early.

A snoozed thread keeps working and stays hidden until its wake time, even while
its agent wakes itself for background work. It comes back early for an approval,
a new question until you have read it, a failed run, or a message or answer you send. You can snooze an existing
question and answer when the thread wakes; the question stays unanswered.

### Set aside

**Snooze → Set aside** keeps a thread in Later with no wake time, until you bring it back
or it needs you. `thread.setAside` (`mod+alt+l`) sets the open thread aside, or brings it
back if it already is; it is also in the command palette. **Undo** puts it back where it was.

### Re-check with a question

When an answer isn't ready yet, such as test results that need a day, choose
**Snooze → Re-check with a question…**, pick a time, and write the question. **After the next
publish** waits until you [mark the project published](#history-every-topic), then asks an
hour later. The thread
waits in Later showing the time and the question's first line. At that time the question
is sent to the thread's agent, which works on it without you, and the thread comes back
when the run finishes. If you open the thread before then, the re-check still runs.

An agent can schedule its own re-check when you ask for something it can't answer yet,
and tells you when. The thread moves to Later once you've read the reply and left it, but only
if the reply asks nothing of you: no question, and nothing to check, commit, or publish. If you write to
the thread again, the re-check still runs, but the answers to what you wrote stay where you can
see them instead of moving to Later. If the re-check
finds nothing new, the agent can schedule another, and the row reads **Re-check 2 of 3**.
After the last one it must report what it found. Set how many it may chain in
**Settings → Threads → Unattended re-checks**; **Off** stops agents scheduling them, and
your own re-checks still work. Writing to the thread starts the count again.

The thread's details panel shows the full question with **Edit** and **Cancel**. You can
also cancel from the thread's menu or the command palette. When you cancel the thread you
have open, **Undo** restores the re-check.

On mobile, Later rows show the same labels. Mobile can set a thread aside and cancel a
re-check or a standing check from a row's menu; scheduling a re-check or making a standing
check needs web or desktop.

## Use the classic sidebar

Turn on **Settings → General → Classic sidebar** on web and desktop to get the earlier
layout back: an active list you order by hand, then Working, Snoozed, and Settled at the
bottom. It also brings back the options that only apply to that layout: **Working
section**, **Needs you section**, **Finished threads in Needs you**, and the boring
sidebar in Labs. Each device keeps its own choice.
