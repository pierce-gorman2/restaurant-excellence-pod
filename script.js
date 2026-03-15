const episodeGrid = document.getElementById("episode-grid");
const filterButtons = document.querySelectorAll(".filter-button");

const placeholderEpisodes = [
  { category: "Operations" },
  { category: "Interviews" },
  { category: "Vision & Mission" },
  { category: "Culture" },
  { category: "Training" },
  { category: "Operations" }
];

function renderEpisodes(filter = "all") {
  if (!episodeGrid) {
    return;
  }

  const visibleEpisodes =
    filter === "all"
      ? placeholderEpisodes
      : placeholderEpisodes.filter((episode) => episode.category === filter);

  episodeGrid.innerHTML = visibleEpisodes
    .map(
      (episode, index) => `
        <article class="episode-card">
          <div>
            <div class="episode-topline">
              <span class="episode-chip">${episode.category}</span>
              <span class="episode-chip">Placeholder</span>
            </div>
            <h3 class="episode-placeholder-title">Episode Placeholder ${index + 1}</h3>
            <p class="episode-placeholder-text">
              Add title, description, links, and episode details here later.
            </p>
          </div>
        </article>
      `
    )
    .join("");
}

filterButtons.forEach((button) => {
  button.addEventListener("click", () => {
    filterButtons.forEach((btn) => btn.classList.remove("active"));
    button.classList.add("active");
    renderEpisodes(button.dataset.filter);
  });
});

renderEpisodes();
