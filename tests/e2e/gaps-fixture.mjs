// This configuration describes the synthetic pages below and is never built into dist.
export const gapsFixtureConfig = {
  label: "X",
  hosts: ["x.com"],
  matches: ["*://x.com/gaps/*"],
  actions: [
    { action: "like", selectors: ["[data-like-button]"] },
    { action: "save", texts: ["Save this item"] },
  ],
  containerSelectors: ["article"],
  imageSelector: "img",
  imageUrlPattern: "/media/",
  item: { type: "post", idPattern: "/item/(\\d+)" },
  gaps: [{
    pageType: "synthetic-detail",
    pathPattern: "^/gaps/(?:item|login/item)/[0-9]+$",
    containerSelector: "article",
    itemIdAttribute: "data-item-id",
    readySelector: "[data-ready]",
    loggedInSelector: "[data-session]",
    loginRequiredSelector: "[data-login-required]",
    actions: {
      like: {
        applicableSelector: "[data-like-applicable]",
        unoperatedSelector: '[data-like-state="unoperated"]',
        operatedSelector: '[data-like-state="operated"]',
      },
      save: {
        applicableSelector: "[data-save-applicable]",
        unoperatedSelector: '[data-save-state="unoperated"]',
        operatedSelector: '[data-save-state="operated"]',
      },
    },
    imageReadySelector: "[data-images-ready]",
  }],
};

export function fixturePage(itemId, {
  like = true,
  likeState = "unoperated",
  save = true,
  loginRequired = false,
  password = false,
  signedIn = true,
  ready = true,
  imageReady = true,
  images = ["a"],
  duplicateContainer = false,
  extra = "",
} = {}) {
  const item = `<article data-item-id="${itemId}">
    <span ${ready ? "data-ready" : ""}>Item</span>
    <span data-like-applicable data-like-state="${likeState}">Like state</span>
    <span data-save-applicable data-save-state="unoperated">Save state</span>
    ${like ? "<button data-like-button>Like</button>" : ""}
    ${save ? "<button>Save this item</button>" : ""}
    <div ${imageReady ? "data-images-ready" : ""}>
      ${images.map((image) => `<img src="/media/${image}" width="32" height="32">`).join("")}
    </div>
  </article>`;
  return `<!doctype html><meta charset="utf-8">
    ${signedIn ? "<span data-session>Signed in</span>" : ""}
    ${loginRequired ? "<span data-login-required>Please sign in</span>" : ""}
    ${password ? '<input aria-label="Password" type="password">' : ""}
    ${item}${duplicateContainer ? item : ""}${extra}`;
}
