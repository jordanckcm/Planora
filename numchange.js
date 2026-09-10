const number = document.getElementById("randomNumberone");

setInterval(() => {
    let result = "";

    for (let i = 0; i < 4; i++) {
        result += Math.floor(Math.random() * 10);
    }

    number.textContent = result;
}, 100);
