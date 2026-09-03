export const DEFAULT_STUDY_TOPIC = "WebMCP as a software developer";
export const MAX_STUDY_TOPIC_LENGTH = 80;

const STUDY_MAP_PROMPT_PREFIX =
  "Use your iab (in-app browser) to open https://hungson175.github.io/study-map/. Call how_to_use first, then help guide me to learn about ";

export const STUDY_MAP_START_PROMPT =
  "Use your iab (in-app browser) to open https://hungson175.github.io/study-map/. Call how_to_use first, then help guide me to learn about WebMCP as a software developer";

const normalizeStudyTopic = (topic: string) =>
  topic.trim().replace(/\s+/gu, " ").slice(0, MAX_STUDY_TOPIC_LENGTH) ||
  DEFAULT_STUDY_TOPIC;

export const buildStudyMapStartPrompt = (topic: string) => {
  const normalizedTopic = normalizeStudyTopic(topic);
  return normalizedTopic === DEFAULT_STUDY_TOPIC
    ? STUDY_MAP_START_PROMPT
    : `${STUDY_MAP_PROMPT_PREFIX}${normalizedTopic}`;
};

let currentStudyTopic = DEFAULT_STUDY_TOPIC;
const topicListeners = new Set<() => void>();

export const getStudyMapTopic = () => currentStudyTopic;

export const setStudyMapTopic = (topic: string) => {
  const nextTopic = topic.slice(0, MAX_STUDY_TOPIC_LENGTH);
  if (nextTopic === currentStudyTopic) {
    return;
  }
  currentStudyTopic = nextTopic;
  topicListeners.forEach((listener) => listener());
};

export const subscribeToStudyMapTopic = (listener: () => void) => {
  topicListeners.add(listener);
  return () => topicListeners.delete(listener);
};
