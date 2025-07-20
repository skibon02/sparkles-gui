let trace = {
  start: () => {
    return performance.now();
  },
  end: (start, name) => {
    console.timeStamp(name, start, undefined, "Tracing");
  }
}

export default trace;